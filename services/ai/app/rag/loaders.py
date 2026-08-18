"""Turns a workspace's quote, invoice, contract or client note into text
for indexing. Every lookup is scoped to the caller's
workspace: an id from another workspace loads nothing."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.public_models import (
    Client,
    ContractInstance,
    Invoice,
    InvoiceLineItem,
    Quote,
    QuoteLineItem,
)
from app.db.scoped import scoped

SOURCE_TYPES = ("quote", "invoice", "contract", "client_note")
_TAG = re.compile(r"<[^>]+>")
_BLOCK = re.compile(r"</?(p|div|br|li|h[1-6]|tr)[^>]*>", re.I)


def utc(value: datetime) -> datetime:
    """Prisma stores UTC in ``timestamp without time zone``; make it aware so
    it is not read as the process's local time when written to timestamptz."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


@dataclass(frozen=True)
class SourceDocument:
    source_type: str
    source_id: str
    workspace_id: str
    text: str
    updated_at: datetime
    metadata: dict[str, Any] = field(default_factory=dict)


def html_to_text(value: str) -> str:
    text = _BLOCK.sub("\n", value)
    text = html.unescape(_TAG.sub("", text))
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def _money(value: Decimal, currency: str) -> str:
    return f"{currency} {value:,.2f}"


def _lines(items: list[QuoteLineItem] | list[InvoiceLineItem], currency: str) -> list[str]:
    rows = ["| Item | Qty | Rate | Amount | HSN/SAC |", "|---|---|---|---|---|"]
    for item in items:
        name = item.name + (f": {item.description}" if item.description else "")
        rows.append(
            f"| {name} | {item.quantity} | {_money(item.rate, currency)} | "
            f"{_money(item.amount, currency)} | {item.hsn_sac or ''} |"
        )
    return rows


async def _client_name(session: AsyncSession, workspace_id: str, client_id: str | None) -> str:
    if not client_id:
        return ""
    name = await session.scalar(
        scoped(Client, workspace_id).where(Client.id == client_id).with_only_columns(Client.name)
    )
    return name or ""


async def _quote(session: AsyncSession, ws: str, source_id: str) -> SourceDocument | None:
    quote = await session.scalar(scoped(Quote, ws).where(Quote.id == source_id))
    if quote is None:
        return None
    items = list(
        await session.scalars(
            select(QuoteLineItem)
            .where(QuoteLineItem.quote_id == quote.id)
            .order_by(QuoteLineItem.sort_order)
        )
    )
    client = await _client_name(session, ws, quote.client_id)
    parts = [
        f"Quote {quote.quote_number}: {quote.title or ''}".strip(),
        f"Client: {client}",
        f"Status: {quote.status}. Issued {quote.issue_date}. "
        f"Total {_money(quote.total, quote.currency)}.",
        *_lines(items, quote.currency),
        f"Notes: {quote.notes}" if quote.notes else "",
        f"Terms: {quote.terms}" if quote.terms else "",
    ]
    return SourceDocument(
        "quote",
        quote.id,
        ws,
        "\n".join(p for p in parts if p),
        utc(quote.updated_at),
        {
            "number": quote.quote_number,
            "client_name": client,
            "date": str(quote.issue_date),
            "total": str(quote.total),
            "currency": quote.currency,
            "status": quote.status,
        },
    )


async def _invoice(session: AsyncSession, ws: str, source_id: str) -> SourceDocument | None:
    invoice = await session.scalar(scoped(Invoice, ws).where(Invoice.id == source_id))
    if invoice is None:
        return None
    items = list(
        await session.scalars(
            select(InvoiceLineItem)
            .where(InvoiceLineItem.invoice_id == invoice.id)
            .order_by(InvoiceLineItem.sort_order)
        )
    )
    client = await _client_name(session, ws, invoice.client_id)
    cur = invoice.currency
    parts = [
        f"Invoice {invoice.invoice_number}: {invoice.title or ''}".strip(),
        f"Client: {client}",
        f"Status: {invoice.status}. Issued {invoice.issue_date}, due {invoice.due_date}. "
        f"Total {_money(invoice.total, cur)}, paid {_money(invoice.amount_paid, cur)}, "
        f"due {_money(invoice.amount_due, cur)}.",
        *_lines(items, cur),
        f"Notes: {invoice.notes}" if invoice.notes else "",
        f"Terms: {invoice.terms}" if invoice.terms else "",
    ]
    return SourceDocument(
        "invoice",
        invoice.id,
        ws,
        "\n".join(p for p in parts if p),
        utc(invoice.updated_at),
        {
            "number": invoice.invoice_number,
            "client_name": client,
            "date": str(invoice.issue_date),
            "total": str(invoice.total),
            "currency": cur,
            "status": invoice.status,
        },
    )


async def _contract(session: AsyncSession, ws: str, source_id: str) -> SourceDocument | None:
    contract = await session.scalar(
        scoped(ContractInstance, ws).where(ContractInstance.id == source_id)
    )
    if contract is None:
        return None
    client = await _client_name(session, ws, contract.client_id)
    text = f"Contract for {client}. Status: {contract.status}.\n{html_to_text(contract.content)}"
    return SourceDocument(
        "contract",
        contract.id,
        ws,
        text,
        utc(contract.updated_at),
        {"client_name": client, "status": contract.status, "date": str(contract.created_at.date())},
    )


async def _client_note(session: AsyncSession, ws: str, source_id: str) -> SourceDocument | None:
    client = await session.scalar(scoped(Client, ws).where(Client.id == source_id))
    if client is None or not client.notes:
        return None
    return SourceDocument(
        "client_note",
        client.id,
        ws,
        f"Notes on client {client.name}:\n{client.notes}",
        utc(client.updated_at),
        {"client_name": client.name},
    )


_LOADERS = {
    "quote": _quote,
    "invoice": _invoice,
    "contract": _contract,
    "client_note": _client_note,
}


async def load_document(
    session: AsyncSession, workspace_id: str, source_type: str, source_id: str
) -> SourceDocument | None:
    """The document, or None when it does not exist in this workspace."""
    loader = _LOADERS.get(source_type)
    if loader is None:
        raise ValueError(f"unknown source type {source_type!r}")
    return await loader(session, workspace_id, source_id)
