from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine

from app.agent.quote_agent import DraftError, draft_quote
from app.auth import Caller, InsufficientScope
from app.db.models import AgentRun
from app.db.session import session_factory
from app.llm import fake
from app.services import Services
from tests.conftest import FakeApi, requires_db, service_token
from tests.seed import Seeded


def caller(ws: Seeded, scopes: tuple[str, ...] = ("ai:use", "quotes:write")) -> Caller:
    return Caller(
        issuer="web", workspace_id=ws.workspace_id, user_id=ws.user_id, scopes=frozenset(scopes)
    )


@pytest.fixture
def override() -> Iterator[dict[str, Any]]:
    """Replace the fake model's QuoteDraft output for one test."""
    box: dict[str, Any] = {}
    fake.STRUCTURED["QuoteDraft"] = lambda messages: box["make"](messages)
    yield box
    fake.STRUCTURED.pop("QuoteDraft", None)


@requires_db
async def test_drafts_from_rate_cards_and_saves_through_the_api(
    services: Services, fake_api: FakeApi, ws_a: Seeded, migrated: AsyncEngine
) -> None:
    result = await draft_quote(
        services, caller(ws_a), "Draft a quote for Acme Robotics: UX audit and landing page build"
    )
    assert result.quote_id == "q-new" and not result.tax_pending
    assert result.draft.client_id == ws_a.client_id
    assert [line.name for line in result.draft.line_items] == ["Landing page build", "UX audit"]
    paths = [c[0] for c in fake_api.calls]
    assert paths == ["/internal/gst/compute", "/internal/quotes/draft"]
    for _, claims, _ in fake_api.calls:
        assert claims["workspaceId"] == ws_a.workspace_id
        assert claims["sub"] == ws_a.user_id
        assert claims["scopes"] == ["quotes:write"]
    body = fake_api.calls[1][2]
    assert body["clientId"] == ws_a.client_id
    lines: list[dict[str, Any]] = body["lineItems"]  # type: ignore[assignment]
    assert {li["sourceRef"] for li in lines} <= set(ws_a.rate_card_ids)
    async with session_factory(migrated)() as s:
        run = await s.scalar(
            select(AgentRun).where(
                AgentRun.workspace_id == ws_a.workspace_id,
                AgentRun.kind == "quote_draft",
                AgentRun.status == "ok",
            )
        )
    assert (
        run is not None and run.prompt_version and run.prompt_version.startswith("quote-draft-v1")
    )


@requires_db
@pytest.mark.parametrize(
    "brief",
    [
        "Draft a quote for Nobody Ltd: a website",
        "Draft a quote for Bluefin Foods: app prototype",  # workspace B's client
    ],
)
async def test_never_invents_or_borrows_a_client(
    services: Services, fake_api: FakeApi, ws_a: Seeded, ws_b: Seeded, brief: str
) -> None:
    with pytest.raises(DraftError) as caught:
        await draft_quote(services, caller(ws_a), brief)
    assert caught.value.code in {"unknown_client", "invalid_output"}
    assert fake_api.calls == []


@requires_db
async def test_a_rate_card_of_another_workspace_is_refused(
    services: Services,
    fake_api: FakeApi,
    ws_a: Seeded,
    ws_b: Seeded,
    override: dict[str, Any],
) -> None:
    def make(messages: list[dict[str, Any]]) -> dict[str, Any]:
        good = fake._quote_draft(messages)
        good["line_items"][0]["source_ref"] = ws_b.rate_card_ids[0]
        return good

    override["make"] = make
    with pytest.raises(DraftError) as caught:
        await draft_quote(services, caller(ws_a), "Draft a quote for Acme Robotics: UX audit")
    assert caught.value.code == "unknown_rate_card" and fake_api.calls == []


@requires_db
async def test_invalid_output_is_repaired_once_then_refused(
    services: Services, fake_api: FakeApi, ws_a: Seeded, override: dict[str, Any]
) -> None:
    attempts: list[int] = []

    def bad_then_good(messages: list[dict[str, Any]]) -> dict[str, Any]:
        attempts.append(1)
        draft = fake._quote_draft(messages)
        if len(attempts) == 1:
            draft["line_items"][0]["qty"] = 0
        return draft

    override["make"] = bad_then_good
    result = await draft_quote(services, caller(ws_a), "Draft a quote for Acme Robotics: UX audit")
    assert len(attempts) == 2 and result.quote_id == "q-new"

    fake_api.calls.clear()
    override["make"] = lambda m: {**fake._quote_draft(m), "confidence": 7}
    with pytest.raises(DraftError) as caught:
        await draft_quote(services, caller(ws_a), "Draft a quote for Acme Robotics: UX audit")
    assert caught.value.code == "invalid_output" and fake_api.calls == []


@requires_db
async def test_gst_degrades_to_pending_but_saving_needs_the_api(
    services: Services, fake_api: FakeApi, ws_a: Seeded
) -> None:
    fake_api.down = {"/internal/gst/compute"}
    result = await draft_quote(services, caller(ws_a), "Draft a quote for Acme Robotics: logo")
    assert result.tax_pending and result.gst is None and result.warnings
    fake_api.down = {"/internal/gst/compute", "/internal/quotes/draft"}
    with pytest.raises(DraftError) as caught:
        await draft_quote(services, caller(ws_a), "Draft a quote for Acme Robotics: logo")
    assert caught.value.code == "api_unavailable"


@requires_db
async def test_needs_quotes_write(services: Services, ws_a: Seeded) -> None:
    with pytest.raises(InsufficientScope):
        await draft_quote(services, caller(ws_a, ("ai:use",)), "Draft a quote for Acme Robotics")


@requires_db
async def test_drafts_endpoint(client: AsyncClient, ws_a: Seeded) -> None:
    token = service_token(ws_a.workspace_id, ["ai:use", "quotes:write"], user=ws_a.user_id)
    r = await client.post(
        "/drafts",
        json={"brief": "Draft a quote for Acme Robotics: UX audit"},
        headers={"authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["builderUrl"] == "/quotes/q-new/builder"
    token = service_token(ws_a.workspace_id, ["ai:use", "quotes:write"], user=ws_a.user_id)
    r = await client.post(
        "/drafts",
        json={"brief": "Draft a quote for Nobody: x"},
        headers={"authorization": f"Bearer {token}"},
    )
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_client"
