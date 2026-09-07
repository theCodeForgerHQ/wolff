from __future__ import annotations

import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.conftest import requires_db, service_token
from tests.seed import Seeded


def auth(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


@requires_db
async def test_worker_indexes_a_document_of_its_workspace(
    client: AsyncClient, ws_a: Seeded
) -> None:
    token = service_token(ws_a.workspace_id, ["ai:index"], issuer="worker", user=None)
    r = await client.post(
        "/ingest", json={"sourceType": "quote", "sourceId": ws_a.quote_id}, headers=auth(token)
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["outcome"] in {"indexed", "unchanged"}


@requires_db
async def test_ingest_rejects_web_tokens_missing_scope_and_no_token(
    client: AsyncClient, ws_a: Seeded
) -> None:
    body = {"sourceType": "quote", "sourceId": ws_a.quote_id}
    web = service_token(ws_a.workspace_id, ["ai:index"], issuer="web")
    no_scope = service_token(ws_a.workspace_id, ["ai:use"], issuer="worker")
    assert (await client.post("/ingest", json=body, headers=auth(web))).status_code == 401
    assert (await client.post("/ingest", json=body, headers=auth(no_scope))).status_code == 403
    assert (await client.post("/ingest", json=body)).status_code == 401


@requires_db
async def test_sweep_indexes_what_changed_in_the_callers_workspace_only(
    client: AsyncClient, ws_a: Seeded, ws_b: Seeded
) -> None:
    token = service_token(ws_a.workspace_id, ["ai:index"], issuer="worker", user=None)
    r = await client.post("/ingest/sweep", headers=auth(token))
    assert r.status_code == 200, r.text
    first = r.json()["data"]
    again = (
        await client.post(
            "/ingest/sweep",
            headers=auth(service_token(ws_a.workspace_id, ["ai:index"], issuer="worker")),
        )
    ).json()["data"]
    assert again["processed"] == 0, (first, again)
    assert first["processed"] >= 1


async def _extra_quote(admin: AsyncEngine, ws: Seeded, title: str) -> str:
    quote_id = str(uuid.uuid4())
    async with admin.begin() as c:
        await c.execute(
            text(
                "INSERT INTO quotes (id, workspace_id, client_id, quote_number, status, title, "
                "subtotal, total, currency, access_token, updated_at) VALUES "
                "(:id, :w, :c, :n, 'draft', :t, 1, 1, 'INR', :tok, now())"
            ),
            {
                "id": quote_id,
                "w": ws.workspace_id,
                "c": ws.client_id,
                "n": f"Q-DEL-{quote_id[:6]}",
                "t": title,
                "tok": str(uuid.uuid4()),
            },
        )
    return quote_id


async def _found(client: AsyncClient, ws: Seeded, query: str, source_id: str) -> bool:
    token = service_token(ws.workspace_id, ["ai:use"], issuer="web")
    r = await client.post("/search", json={"query": query}, headers=auth(token))
    assert r.status_code == 200, r.text
    return any(d["metadata"]["source_id"] == source_id for d in r.json()["data"])


async def _ingest(client: AsyncClient, ws: Seeded, kind: str, source_id: str) -> str:
    token = service_token(ws.workspace_id, ["ai:index"], issuer="worker", user=None)
    r = await client.post(
        "/ingest", json={"sourceType": kind, "sourceId": source_id}, headers=auth(token)
    )
    assert r.status_code == 200, r.text
    return str(r.json()["data"]["outcome"])


async def _sweep(client: AsyncClient, ws: Seeded) -> dict[str, Any]:
    token = service_token(ws.workspace_id, ["ai:index"], issuer="worker", user=None)
    r = await client.post("/ingest/sweep", headers=auth(token))
    assert r.status_code == 200, r.text
    data: dict[str, Any] = r.json()["data"]
    return data


async def _soft_delete(admin: AsyncEngine, quote_id: str) -> None:
    async with admin.begin() as c:
        await c.execute(
            text("UPDATE quotes SET deleted_at = now(), updated_at = now() WHERE id = :id"),
            {"id": quote_id},
        )


@requires_db
async def test_ingest_after_soft_delete_removes_the_document_from_search(
    client: AsyncClient, ws_a: Seeded, admin_engine: AsyncEngine
) -> None:
    query = "zeppelin hangar refit"
    quote_id = await _extra_quote(admin_engine, ws_a, "Zeppelin hangar refit")
    assert await _ingest(client, ws_a, "quote", quote_id) == "indexed"
    assert await _found(client, ws_a, query, quote_id)

    await _soft_delete(admin_engine, quote_id)
    assert await _ingest(client, ws_a, "quote", quote_id) == "removed"
    assert not await _found(client, ws_a, query, quote_id)


@requires_db
async def test_sweep_removes_soft_deleted_documents_and_their_state(
    client: AsyncClient, ws_a: Seeded, admin_engine: AsyncEngine, engine: AsyncEngine
) -> None:
    query = "dirigible mooring mast"
    quote_id = await _extra_quote(admin_engine, ws_a, "Dirigible mooring mast")
    await _sweep(client, ws_a)
    assert await _found(client, ws_a, query, quote_id)

    await _soft_delete(admin_engine, quote_id)
    swept = await _sweep(client, ws_a)
    assert swept["removed"] >= 1, swept
    assert not await _found(client, ws_a, query, quote_id)
    async with engine.connect() as c:
        state = await c.scalar(
            text("SELECT count(*) FROM ai.ingest_state WHERE source_id = :id"), {"id": quote_id}
        )
    assert state == 0
    assert (await _sweep(client, ws_a))["removed"] == 0


@requires_db
async def test_sweep_removes_a_client_note_once_the_notes_are_cleared(
    client: AsyncClient, ws_a: Seeded, admin_engine: AsyncEngine
) -> None:
    client_id = str(uuid.uuid4())
    async with admin_engine.begin() as c:
        await c.execute(
            text(
                "INSERT INTO clients (id, workspace_id, name, email, notes, updated_at) "
                "VALUES (:id, :w, 'Quokka Ltd', :e, 'Quokka wants marsupial branding.', now())"
            ),
            {"id": client_id, "w": ws_a.workspace_id, "e": f"{client_id}@client.dev"},
        )
    await _sweep(client, ws_a)
    assert await _found(client, ws_a, "quokka marsupial branding", client_id)

    async with admin_engine.begin() as c:
        await c.execute(
            text("UPDATE clients SET notes = NULL, updated_at = now() WHERE id = :id"),
            {"id": client_id},
        )
    await _sweep(client, ws_a)
    assert not await _found(client, ws_a, "quokka marsupial branding", client_id)


@requires_db
async def test_sweep_works_in_bounded_batches_and_resumes(
    client: AsyncClient, admin_engine: AsyncEngine, monkeypatch: Any
) -> None:
    """One call must fit in a serverless time limit, so a backlog is worked
    off over several calls; each says whether more is left."""
    from app.api import ingest as ingest_api
    from tests.seed import seed_workspace

    ws = await seed_workspace(admin_engine, "a")
    monkeypatch.setattr(ingest_api, "SWEEP_BATCH", 1)

    calls = []
    while True:
        data = await _sweep(client, ws)
        calls.append(data)
        assert data["processed"] <= 1
        if not data["more"]:
            break
        assert len(calls) < 20
    assert len(calls) >= 3, calls
    assert sum(c["processed"] for c in calls) == len(calls) - 1 + calls[-1]["processed"]
    assert (await _sweep(client, ws)) == {**calls[-1], "processed": 0, "outcomes": {}}


@requires_db
async def test_sweep_stops_at_its_time_budget(
    client: AsyncClient, admin_engine: AsyncEngine, monkeypatch: Any
) -> None:
    from app.api import ingest as ingest_api
    from tests.seed import seed_workspace

    ws = await seed_workspace(admin_engine, "a")
    monkeypatch.setattr(ingest_api, "SWEEP_SECONDS", 0.0)

    data = await _sweep(client, ws)
    assert data["processed"] == 1
    assert data["more"] is True


@requires_db
async def test_a_new_embedding_model_makes_every_source_stale(
    client: AsyncClient, admin_engine: AsyncEngine, migrated: AsyncEngine, fake_api: Any
) -> None:
    """Search only reads chunks of the configured model. After AI_EMBED_MODEL
    changes, the sweep must re-embed what was indexed with the old one, or
    search silently returns nothing."""
    from dataclasses import replace

    from httpx import ASGITransport

    from app.llm.providers import resolve_provider
    from app.main import create_app
    from app.services import build_services
    from tests.conftest import make_settings
    from tests.seed import seed_workspace

    ws = await seed_workspace(admin_engine, "a")
    while (await _sweep(client, ws))["more"]:
        pass

    renamed = replace(resolve_provider({"LLM_PROVIDER": "fake"}), embed_model="fake-embed-2")
    svc = build_services(make_settings(provider=renamed), engine=migrated, api=fake_api.client())
    app = create_app(services=svc)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://ai") as other:
        first = await _sweep(other, ws)
        while (await _sweep(other, ws))["more"]:
            pass
    await svc.llm.aclose()

    assert first["processed"] > 0
    async with migrated.connect() as conn:
        models: set[str] = set(
            (
                await conn.execute(
                    text(
                        "SELECT DISTINCT embedding_model FROM ai.document_chunks "
                        "WHERE workspace_id = :w"
                    ),
                    {"w": ws.workspace_id},
                )
            ).scalars()
        )
    assert models == {"fake-embed-2"}


@requires_db
async def test_a_failing_source_is_recorded_and_does_not_block_the_sweep(
    client: AsyncClient, admin_engine: AsyncEngine, migrated: AsyncEngine, monkeypatch: Any
) -> None:
    """A source whose loading or embedding raises must not fail the sweep
    call (500) and, picked first every run, keep the rest from indexing: it
    is recorded as an error and given up after MAX_INGEST_ATTEMPTS."""
    from app.api import ingest as ingest_api
    from app.rag import ingest as rag_ingest
    from app.rag.loaders import load_document
    from tests.seed import seed_workspace

    ws = await seed_workspace(admin_engine, "a")
    poison = ws.quote_id
    load = load_document

    async def broken(session: Any, workspace_id: str, kind: str, source_id: str) -> Any:
        if source_id == poison:
            raise ValueError("cannot render this quote")
        return await load(session, workspace_id, kind, source_id)

    monkeypatch.setattr(rag_ingest, "load_document", broken)
    monkeypatch.setattr(ingest_api, "SWEEP_BATCH", 1)

    calls = 0
    while (await _sweep(client, ws))["processed"]:
        calls += 1
        assert calls < 30

    async with migrated.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT source_id, status, error, attempts FROM ai.ingest_state "
                    "WHERE workspace_id = :w"
                ),
                {"w": ws.workspace_id},
            )
        ).all()
    states = {r.source_id: r for r in rows}
    assert states[poison].status == "error"
    assert "cannot render this quote" in states[poison].error
    assert states[poison].attempts == ingest_api.MAX_INGEST_ATTEMPTS
    others = [r for r in rows if r.source_id != poison]
    assert others and all(r.status == "indexed" and r.attempts == 0 for r in others)


@requires_db
async def test_an_embedding_provider_failure_is_503_and_not_the_sources_fault(
    client: AsyncClient, admin_engine: AsyncEngine, migrated: AsyncEngine, monkeypatch: Any
) -> None:
    from openai import APIConnectionError

    from app.llm.clients import LlmClients
    from tests.seed import seed_workspace

    ws = await seed_workspace(admin_engine, "a")

    async def down(self: Any, texts: Any) -> Any:
        raise APIConnectionError(request=None)  # type: ignore[arg-type]

    monkeypatch.setattr(LlmClients, "embed", down)
    token = service_token(ws.workspace_id, ["ai:index"], issuer="worker", user=None)
    r = await client.post("/ingest/sweep", headers=auth(token))
    assert r.status_code == 503, r.text
    assert r.json()["error"]["code"] == "ai_unavailable"
    token = service_token(ws.workspace_id, ["ai:index"], issuer="worker", user=None)
    one = await client.post(
        "/ingest", json={"sourceType": "quote", "sourceId": ws.quote_id}, headers=auth(token)
    )
    assert one.status_code == 503, one.text
    async with migrated.connect() as conn:
        errors = await conn.scalar(
            text(
                "SELECT count(*) FROM ai.ingest_state WHERE workspace_id = :w AND status = 'error'"
            ),
            {"w": ws.workspace_id},
        )
    assert errors == 0
