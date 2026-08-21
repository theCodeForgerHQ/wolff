"""Every MCP tool through an in-process MCP client, as
workspace A and B, including scope denials and cross-tenant ids."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from mcp import Client
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.agent import queries
from app.auth import Caller
from app.db.session import session_factory
from app.llm.fake import embed as fake_embed
from app.mcp.auth import ApiKeyTokenVerifier, caller_from_token
from app.mcp.server import TOOL_NAMES, build_mcp_server
from app.rag.ingest import ingest
from app.services import Services
from tests.conftest import FakeApi, requires_db
from tests.seed import KEY_SCOPES, Seeded


async def caller_for(svc: Services, raw_key: str) -> Caller:
    token = await ApiKeyTokenVerifier(svc.sessions, "wolff").verify_token(raw_key)
    assert token is not None
    caller = caller_from_token(token)
    assert caller is not None
    return caller


@asynccontextmanager
async def mcp_as(svc: Services, ws: Seeded) -> AsyncIterator[Client]:
    server = build_mcp_server(svc, fixed_caller=await caller_for(svc, ws.api_key))
    async with Client(server) as client:
        yield client


def payload(result: Any) -> Any:
    assert not result.is_error, result.content
    if result.structured_content is not None:
        content = result.structured_content
        return content.get("result", content) if isinstance(content, dict) else content
    return json.loads(result.content[0].text)


def error_text(result: Any) -> str:
    assert result.is_error
    return str(result.content[0].text)


async def embed(texts: Sequence[str]) -> list[list[float]]:
    return [fake_embed(t) for t in texts]


@pytest.fixture
async def indexed(migrated: AsyncEngine, ws_a: Seeded, ws_b: Seeded) -> None:
    for ws in (ws_a, ws_b):
        async with session_factory(migrated)() as s:
            await ingest(
                s,
                workspace_id=ws.workspace_id,
                source_type="contract",
                source_id=ws.contract_id,
                embed=embed,
                embedding_model="fake-embed",
            )


@requires_db
async def test_lists_exactly_the_spec_tools_and_resources(services: Services, ws_a: Seeded) -> None:
    async with mcp_as(services, ws_a) as client:
        tools = await client.list_tools()
        templates = await client.list_resource_templates()
    assert sorted(t.name for t in tools.tools) == sorted(TOOL_NAMES)
    assert sorted(t.uri_template for t in templates.resource_templates) == [
        "invoice://{invoice_id}",
        "quote://{quote_id}",
    ]


@requires_db
@pytest.mark.usefixtures("indexed")
async def test_every_tool_as_workspace_a(
    services: Services, fake_api: FakeApi, ws_a: Seeded
) -> None:
    async with mcp_as(services, ws_a) as c:
        docs = payload(await c.call_tool("search_documents", {"query": "payment due 15 days"}))
        assert docs[0]["source_id"] == ws_a.contract_id
        assert [x["id"] for x in payload(await c.call_tool("list_leads", {}))] == [ws_a.lead_id]
        assert payload(await c.call_tool("create_lead", {"name": "From Claude"})) == {"id": "x"}
        assert [x["id"] for x in payload(await c.call_tool("list_deals", {}))] == [ws_a.deal_id]
        payload(
            await c.call_tool("move_deal", {"deal_id": ws_a.deal_id, "stage_id": ws_a.stage_ids[1]})
        )
        assert (
            payload(await c.call_tool("get_invoice", {"invoice_id": ws_a.invoice_id}))["client"]
            == "Acme Robotics"
        )
        overdue = payload(await c.call_tool("list_overdue_invoices", {}))
        assert [x["invoice_id"] for x in overdue] == [ws_a.overdue_invoice_id]
        ageing = payload(await c.call_tool("receivables_ageing", {}))
        assert ageing == [
            {"currency": "INR", "bucket": "bucket_31_60", "amount_due": 90000.0, "invoices": 1}
        ]
        assert payload(await c.call_tool("gst_summary", {}))[0]["cgst"] == 16200.0
        draft = payload(
            await c.call_tool("draft_quote", {"brief": "Draft a quote for Acme Robotics: UX audit"})
        )
        assert draft["quote_id"] == "q-new"
        quote = await c.read_resource(f"quote://{ws_a.quote_id}")
        invoice = await c.read_resource(f"invoice://{ws_a.invoice_id}")
    assert "Landing page build" in quote.contents[0].text  # type: ignore[union-attr]
    assert "Acme Robotics" in invoice.contents[0].text  # type: ignore[union-attr]
    writes = [
        (path, claims["workspaceId"], claims.get("sub")) for path, claims, _ in fake_api.calls
    ]
    assert ("/internal/leads", ws_a.workspace_id, None) in writes
    assert (f"/internal/deals/{ws_a.deal_id}/move", ws_a.workspace_id, None) in writes
    assert all(ws == ws_a.workspace_id for _, ws, _ in writes)


@requires_db
@pytest.mark.usefixtures("indexed")
async def test_workspace_a_cannot_reach_workspace_b(
    services: Services, ws_a: Seeded, ws_b: Seeded
) -> None:
    async with mcp_as(services, ws_a) as c:
        docs = payload(
            await c.call_tool(
                "search_documents", {"query": "Bluefin confidential clause B-ONLY-SECRET"}
            )
        )
        assert all(d["source_id"] != ws_b.contract_id for d in docs)
        assert "not found" in error_text(
            await c.call_tool("get_invoice", {"invoice_id": ws_b.invoice_id})
        )
        for uri in (f"invoice://{ws_b.invoice_id}", f"quote://{ws_b.quote_id}"):
            with pytest.raises(Exception, match="not found"):
                await c.read_resource(uri)
        listed = payload(await c.call_tool("list_leads", {}))
        assert ws_b.lead_id not in {x["id"] for x in listed}
        error = error_text(
            await c.call_tool(
                "draft_quote", {"brief": "Draft a quote for Bluefin Foods: app prototype"}
            )
        )
        assert "client" in error.lower()


@requires_db
async def test_each_tool_checks_its_scope(
    services: Services, admin_engine: AsyncEngine, ws_a: Seeded
) -> None:
    async with admin_engine.begin() as conn:
        await conn.execute(
            text("UPDATE api_keys SET scopes = ARRAY['ai:use'] WHERE id = :id"),
            {"id": ws_a.api_key_id},
        )
    try:
        async with mcp_as(services, ws_a) as c:
            for name, args in [
                ("list_leads", {}),
                ("create_lead", {"name": "x"}),
                ("list_deals", {}),
                ("move_deal", {"deal_id": ws_a.deal_id, "stage_id": ws_a.stage_ids[1]}),
                ("get_invoice", {"invoice_id": ws_a.invoice_id}),
                ("list_overdue_invoices", {}),
                ("receivables_ageing", {}),
                ("gst_summary", {}),
                ("draft_quote", {"brief": "Draft a quote for Acme Robotics: UX"}),
            ]:
                assert "scope" in error_text(await c.call_tool(name, args)), name
    finally:
        await set_scopes(admin_engine, ws_a, KEY_SCOPES)


async def set_scopes(admin: AsyncEngine, ws: Seeded, scopes: Sequence[str]) -> None:
    async with admin.begin() as conn:
        await conn.execute(
            text("UPDATE api_keys SET scopes = :scopes WHERE id = :id"),
            {"id": ws.api_key_id, "scopes": list(scopes)},
        )


@requires_db
async def test_search_documents_returns_only_types_the_key_may_read(
    services: Services, admin_engine: AsyncEngine, migrated: AsyncEngine, ws_a: Seeded
) -> None:
    for kind, source_id in (
        ("quote", ws_a.quote_id),
        ("invoice", ws_a.invoice_id),
        ("contract", ws_a.contract_id),
        ("client_note", ws_a.client_id),
    ):
        async with session_factory(migrated)() as s:
            await ingest(
                s,
                workspace_id=ws_a.workspace_id,
                source_type=kind,
                source_id=source_id,
                embed=embed,
                embedding_model="fake-embed",
            )
    # Words from all four documents: the quote's lines, the invoice title,
    # the contract's payment clause and the client note.
    query = {"query": "Website redesign UX audit landing page payment due prefers invoices"}
    try:
        await set_scopes(admin_engine, ws_a, ["ai:use", "quotes:read"])
        async with mcp_as(services, ws_a) as c:
            docs = payload(await c.call_tool("search_documents", query))
            assert docs and {d["source_type"] for d in docs} == {"quote"}
            asked = await c.call_tool("search_documents", {**query, "types": ["invoice"]})
            assert "scope" in error_text(asked)

        await set_scopes(admin_engine, ws_a, ["ai:use", "clients:read"])
        async with mcp_as(services, ws_a) as c:
            docs = payload(await c.call_tool("search_documents", query))
            assert docs and {d["source_type"] for d in docs} <= {"contract", "client_note"}

        await set_scopes(admin_engine, ws_a, ["ai:use"])
        async with mcp_as(services, ws_a) as c:
            assert "scope" in error_text(await c.call_tool("search_documents", query))
    finally:
        await set_scopes(admin_engine, ws_a, KEY_SCOPES)


@requires_db
async def test_key_verification(
    services: Services, admin_engine: AsyncEngine, ws_a: Seeded
) -> None:
    v = ApiKeyTokenVerifier(services.sessions, "wolff")
    token = await v.verify_token(ws_a.api_key)
    assert token is not None and token.claims == {"workspace_id": ws_a.workspace_id}
    assert await v.verify_token(ws_a.api_key + "x") is None
    assert await v.verify_token("Bearer " + ws_a.api_key) is None
    assert await v.verify_token("") is None
    for update in (
        "revoked_at = now()",
        "expires_at = now() - interval '1 minute'",
        "kind = 'publishable'",
        "scopes = ARRAY['leads:read']",
    ):
        async with admin_engine.begin() as conn:
            await conn.execute(
                text(f"UPDATE api_keys SET {update} WHERE id = :id"),  # noqa: S608
                {"id": ws_a.api_key_id},
            )
        try:
            assert await v.verify_token(ws_a.api_key) is None, update
        finally:
            async with admin_engine.begin() as conn:
                await conn.execute(
                    text(
                        "UPDATE api_keys SET revoked_at = NULL, expires_at = NULL, "
                        "kind = 'secret', scopes = :scopes WHERE id = :id"
                    ),
                    {"id": ws_a.api_key_id, "scopes": list(KEY_SCOPES)},
                )


@requires_db
async def test_http_transport_at_mcp_requires_a_valid_key(services: Services, ws_a: Seeded) -> None:
    from app.main import create_app

    app = create_app(services=services)
    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        },
    }
    headers = {"accept": "application/json, text/event-stream"}
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8000") as http,
    ):
        assert (await http.post("/mcp/", json=init, headers=headers)).status_code == 401
        bad = {**headers, "authorization": "Bearer qc_sk_nope"}
        assert (await http.post("/mcp/", json=init, headers=bad)).status_code == 401
        good = {**headers, "authorization": f"Bearer {ws_a.api_key}"}
        response = await http.post("/mcp/", json=init, headers=good)
        assert response.status_code == 200, response.text
        assert response.json()["result"]["serverInfo"]["name"] == "wolff"


@requires_db
async def test_a_negative_limit_is_clamped_not_sent_to_postgres(
    services: Services, ws_a: Seeded
) -> None:
    async with mcp_as(services, ws_a) as c:
        for name in ("list_leads", "list_deals"):
            rows = payload(await c.call_tool(name, {"limit": -5}))
            assert len(rows) == 1, name
        async with services.sessions() as s:
            assert len(await queries.top_debtors(s, ws_a.workspace_id, -1)) == 1
            assert len(await queries.past_quotes(s, ws_a.workspace_id, None, -1)) == 1

