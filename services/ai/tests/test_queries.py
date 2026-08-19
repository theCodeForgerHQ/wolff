from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine

from app.agent import queries as q
from app.db.session import session_factory
from tests.conftest import requires_db
from tests.seed import Seeded


@requires_db
async def test_reads_return_the_callers_rows(migrated: AsyncEngine, ws_a: Seeded) -> None:
    ws = ws_a.workspace_id
    async with session_factory(migrated)() as s:
        overdue = await q.overdue_invoices(s, ws)
        assert [o["invoice_id"] for o in overdue] == [ws_a.overdue_invoice_id]
        assert overdue[0]["client"] == "Acme Robotics" and overdue[0]["days_overdue"] == 40
        assert (await q.top_debtors(s, ws))[0] == {
            "client": "Acme Robotics",
            "currency": "INR",
            "amount_due": 90000.0,
        }
        assert await q.receivables_ageing(s, ws) == [
            {"currency": "INR", "bucket": "bucket_31_60", "amount_due": 90000.0, "invoices": 1}
        ]
        # Both invoices left draft; each line is 18% intra-state on 90,000.
        assert await q.gst_summary(s, ws) == [
            {
                "gst_rate": 18.0,
                "taxable_value": 180000.0,
                "cgst": 16200.0,
                "sgst": 16200.0,
                "igst": 0.0,
                "cess": 0.0,
            }
        ]
        assert (await q.get_invoice(s, ws, ws_a.invoice_id))["client"] == "Acme Robotics"  # type: ignore[index]
        assert (await q.get_quote(s, ws, ws_a.quote_id))["total"] == 90000.0  # type: ignore[index]
        assert (await q.find_client(s, ws, "acme"))["client_id"] == ws_a.client_id  # type: ignore[index]
        assert (await q.find_client(s, ws, ws_a.client_id))["name"] == "Acme Robotics"  # type: ignore[index]
        assert [c["name"] for c in await q.list_rate_cards(s, ws, "design")] == ["Logo design"]
        assert len(await q.list_rate_cards(s, ws)) == 3
        assert [d["id"] for d in await q.list_deals(s, ws)] == [ws_a.deal_id]
        assert (await q.get_deal(s, ws, ws_a.deal_id))["stage"] == "New"  # type: ignore[index]
        assert [lead["id"] for lead in await q.list_leads(s, ws)] == [ws_a.lead_id]
        assert [lead["id"] for lead in await q.list_leads(s, ws, "new")] == [ws_a.lead_id]
        assert await q.list_leads(s, ws, "converted") == []
        assert [p["id"] for p in await q.past_quotes(s, ws, ws_a.client_id)] == [ws_a.quote_id]


@requires_db
async def test_another_workspaces_ids_are_not_found(
    migrated: AsyncEngine, ws_a: Seeded, ws_b: Seeded
) -> None:
    ws = ws_a.workspace_id
    async with session_factory(migrated)() as s:
        assert await q.get_invoice(s, ws, ws_b.invoice_id) is None
        assert await q.get_quote(s, ws, ws_b.quote_id) is None
        assert await q.get_deal(s, ws, ws_b.deal_id) is None
        assert await q.find_client(s, ws, ws_b.client_id) is None
        assert await q.find_client(s, ws, "Bluefin") is None
        assert await q.past_quotes(s, ws, ws_b.client_id) == []
        assert await q.list_rate_cards(s, ws, "App prototype") == []


@requires_db
async def test_like_wildcards_in_a_name_are_literal(migrated: AsyncEngine, ws_a: Seeded) -> None:
    async with session_factory(migrated)() as s:
        assert await q.find_client(s, ws_a.workspace_id, "%") is None
        assert await q.list_rate_cards(s, ws_a.workspace_id, "_") == []
