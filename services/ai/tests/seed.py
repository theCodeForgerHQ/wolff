"""Two workspaces of test data, written as the database owner (the AI
service's own login cannot write ``public``)."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


def _id() -> str:
    return str(uuid.uuid4())


@dataclass
class Seeded:
    workspace_id: str
    user_id: str
    client_id: str
    client_name: str
    quote_id: str
    invoice_id: str
    overdue_invoice_id: str
    contract_id: str
    rate_card_ids: list[str]
    lead_id: str
    deal_id: str
    pipeline_id: str
    stage_ids: list[str]
    api_key: str
    api_key_id: str
    extra: dict[str, Any] = field(default_factory=dict)


WORKSPACES: dict[str, dict[str, Any]] = {
    "a": {
        "client": "Acme Robotics",
        "state": "29",
        "quote_title": "Website redesign",
        "lines": [("UX audit", 1, 40000), ("Landing page build", 2, 25000)],
        "contract": "<p>Payment is due within 15 days of the invoice date.</p>"
        "<p>Acme owns the delivered designs.</p>",
        "cards": [
            ("UX audit", 40000, "998314"),
            ("Landing page build", 25000, "998314"),
            ("Logo design", 15000, "998391"),
        ],
        "note": "Acme prefers invoices on the first working day of the month.",
    },
    "b": {
        "client": "Bluefin Foods",
        "state": "27",
        "quote_title": "Mobile app MVP",
        "lines": [("App prototype", 1, 90000)],
        "contract": "<p>Bluefin confidential clause B-ONLY-SECRET: penalty 2% per week.</p>",
        "cards": [("App prototype", 90000, "998314")],
        "note": "Bluefin wants weekly status calls.",
    },
}


async def seed_workspace(admin: AsyncEngine, key: str) -> Seeded:
    spec = WORKSPACES[key]
    ws, user, client = _id(), _id(), _id()
    quote, invoice, overdue, contract = _id(), _id(), _id(), _id()
    lead, pipeline, deal = _id(), _id(), _id()
    stages = [_id(), _id(), _id()]
    cards = [_id() for _ in spec["cards"]]
    raw_key = f"qc_sk_test{key}{uuid.uuid4().hex}"
    key_id = _id()
    today = date.today()
    lines = spec["lines"]
    total = sum(q * r for _, q, r in lines)

    async with admin.begin() as c:
        x = c.execute
        await x(
            text("INSERT INTO users (id, email, name, updated_at) VALUES (:id, :e, :n, now())"),
            {"id": user, "e": f"{user}@test.dev", "n": f"Owner {key}"},
        )
        await x(
            text(
                "INSERT INTO workspaces (id, name, slug, owner_id, updated_at) "
                "VALUES (:id, :n, :s, :u, now())"
            ),
            {"id": ws, "n": f"Workspace {key.upper()}", "s": f"ws-{ws}", "u": user},
        )
        await x(
            text(
                "INSERT INTO workspace_members (id, workspace_id, user_id, role, updated_at) "
                "VALUES (:id, :w, :u, 'owner', now())"
            ),
            {"id": _id(), "w": ws, "u": user},
        )
        await x(
            text(
                "INSERT INTO business_profiles (workspace_id, business_name, gstin, state_code, "
                "gst_registration_type, currency, updated_at) "
                "VALUES (:w, :n, '29ABCDE1234F1Z5', '29', 'regular', 'INR', now())"
            ),
            {"w": ws, "n": f"Studio {key.upper()}"},
        )
        await x(
            text(
                "INSERT INTO clients (id, workspace_id, name, email, state_code, notes, "
                "updated_at) VALUES (:id, :w, :n, :e, :st, :notes, now())"
            ),
            {
                "id": client,
                "w": ws,
                "n": spec["client"],
                "e": f"{client}@client.dev",
                "st": spec["state"],
                "notes": spec["note"],
            },
        )
        await x(
            text(
                "INSERT INTO quotes (id, workspace_id, client_id, quote_number, status, title, "
                "subtotal, total, currency, terms, access_token, updated_at) VALUES "
                "(:id, :w, :c, :n, 'sent', :t, :tot, :tot, 'INR', :terms, :tok, now())"
            ),
            {
                "id": quote,
                "w": ws,
                "c": client,
                "n": f"Q-{key.upper()}-001",
                "t": spec["quote_title"],
                "tot": total,
                "terms": "50% advance.",
                "tok": _id(),
            },
        )
        for i, (name, qty, rate) in enumerate(lines):
            await x(
                text(
                    "INSERT INTO quote_line_items (id, quote_id, name, quantity, rate, amount, "
                    "hsn_sac, sort_order, updated_at) VALUES "
                    "(:id, :q, :n, :qty, :r, :a, '998314', :i, now())"
                ),
                {
                    "id": _id(),
                    "q": quote,
                    "n": name,
                    "qty": qty,
                    "r": rate,
                    "a": qty * rate,
                    "i": i,
                },
            )
        for inv, status, due, paid in (
            (invoice, "paid", today + timedelta(days=10), total),
            (overdue, "overdue", today - timedelta(days=40), 0),
        ):
            await x(
                text(
                    "INSERT INTO invoices (id, workspace_id, client_id, invoice_number, status, "
                    "title, issue_date, due_date, subtotal, total, amount_paid, amount_due, "
                    "currency, access_token, updated_at) VALUES (:id, :w, :c, :n, :s, :t, "
                    ":issue, :due, :tot, :tot, :paid, :owed, 'INR', :tok, now())"
                ),
                {
                    "id": inv,
                    "w": ws,
                    "c": client,
                    "n": f"INV-{key.upper()}-{inv[:4]}",
                    "s": status,
                    "t": spec["quote_title"],
                    "issue": due - timedelta(days=30),
                    "due": due,
                    "tot": total,
                    "paid": paid,
                    "owed": total - paid,
                    "tok": _id(),
                },
            )
            await x(
                text(
                    "INSERT INTO invoice_line_items (id, invoice_id, name, quantity, rate, "
                    "amount, taxable_value, gst_rate, cgst_amount, sgst_amount, hsn_sac, "
                    "updated_at) VALUES (:id, :i, :n, 1, :a, :a, :a, 18, :half, :half, "
                    "'998314', now())"
                ),
                {
                    "id": _id(),
                    "i": inv,
                    "n": spec["quote_title"],
                    "a": total,
                    "half": total * 9 / 100,
                },
            )
        await x(
            text(
                "INSERT INTO contract_instances (id, workspace_id, client_id, content, status, "
                "access_token, updated_at) VALUES (:id, :w, :c, :body, 'signed', :tok, now())"
            ),
            {"id": contract, "w": ws, "c": client, "body": spec["contract"], "tok": _id()},
        )
        for card_id, (name, rate, hsn) in zip(cards, spec["cards"], strict=True):
            await x(
                text(
                    "INSERT INTO rate_cards (id, workspace_id, name, rate, unit, hsn_sac, "
                    "gst_rate, updated_at) VALUES (:id, :w, :n, :r, 'item', :h, 18, now())"
                ),
                {"id": card_id, "w": ws, "n": name, "r": rate, "h": hsn},
            )
        await x(
            text(
                "INSERT INTO leads (id, workspace_id, name, email, company, updated_at) "
                "VALUES (:id, :w, :n, :e, :co, now())"
            ),
            {
                "id": lead,
                "w": ws,
                "n": f"Lead {key}",
                "e": f"{lead}@lead.dev",
                "co": spec["client"],
            },
        )
        await x(
            text(
                "INSERT INTO pipelines (id, workspace_id, name, is_default, updated_at) "
                "VALUES (:id, :w, 'Sales', true, now())"
            ),
            {"id": pipeline, "w": ws},
        )
        for pos, (sid, name, kind) in enumerate(
            zip(stages, ["New", "Proposal", "Won"], ["open", "open", "won"], strict=True)
        ):
            await x(
                text(
                    "INSERT INTO pipeline_stages (id, workspace_id, pipeline_id, name, position, "
                    "probability, kind, updated_at) VALUES (:id, :w, :p, :n, :pos, :pr, "
                    "CAST(:k AS stage_kind), now())"
                ),
                {
                    "id": sid,
                    "w": ws,
                    "p": pipeline,
                    "n": name,
                    "pos": pos,
                    "pr": pos * 40,
                    "k": kind,
                },
            )
        await x(
            text(
                "INSERT INTO deals (id, workspace_id, pipeline_id, stage_id, client_id, title, "
                "value, currency, updated_at) VALUES (:id, :w, :p, :s, :c, :t, :v, 'INR', "
                "now())"
            ),
            {
                "id": deal,
                "w": ws,
                "p": pipeline,
                "s": stages[0],
                "c": client,
                "t": f"{spec['quote_title']} deal",
                "v": total,
            },
        )
        await x(
            text(
                "INSERT INTO api_keys (id, workspace_id, name, key_hash, key_prefix, scopes) "
                "VALUES (:id, :w, 'mcp', :h, :p, :sc)"
            ),
            {
                "id": key_id,
                "w": ws,
                "h": hashlib.sha256(raw_key.encode()).hexdigest(),
                "p": raw_key[:10],
                "sc": [
                    "ai:use",
                    "leads:read",
                    "leads:write",
                    "deals:read",
                    "deals:write",
                    "invoices:read",
                    "quotes:read",
                    "quotes:write",
                    "reports:read",
                ],
            },
        )
    return Seeded(
        ws,
        user,
        client,
        spec["client"],
        quote,
        invoice,
        overdue,
        contract,
        cards,
        lead,
        deal,
        pipeline,
        stages,
        raw_key,
        key_id,
    )
