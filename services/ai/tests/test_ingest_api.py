from __future__ import annotations

from httpx import AsyncClient

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
