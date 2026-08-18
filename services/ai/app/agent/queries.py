"""Read-only lookups the chat agent, the quote agent and the MCP server
share. Every function takes the workspace
from the authenticated caller as its first argument and filters on it in
SQL; none accepts a workspace from a model or a tool argument. A row of
another workspace is reported as not found (None / empty)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import Table, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.public_models import (
    Client,
    Deal,
    Invoice,
    InvoiceLineItem,
    Lead,
    PipelineStage,
    Quote,
    QuoteLineItem,
    RateCard,
    v_gst_outward_supplies,
    v_receivables_ageing,
)
from app.db.scoped import scoped, workspace_filter

MAX_ROWS = 50


def _view(view: Table, workspace_id: str) -> Any:
    if not workspace_id:
        raise ValueError("a workspace is required")
    return view.c.workspace_id == workspace_id


def _num(value: object) -> float:
    if value is None:
        return 0.0
    if isinstance(value, Decimal | int | float):
        return float(value)
    raise TypeError(f"not a number: {value!r}")


def _day(value: date | None) -> str | None:
    return value.isoformat() if value else None


def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def overdue_invoices(session: AsyncSession, ws: str) -> list[dict[str, Any]]:
    v = v_receivables_ageing
    rows = await session.execute(
        select(v, Client.name.label("client_name"))
        .join(Client, Client.id == v.c.client_id)
        .where(_view(v, ws), Client.workspace_id == ws, v.c.days_overdue > 0)
        .order_by(v.c.days_overdue.desc())
        .limit(MAX_ROWS)
    )
    return [
        {
            "invoice_id": r.invoice_id,
            "invoice_number": r.invoice_number,
            "client": r.client_name,
            "currency": r.currency,
            "amount_due": _num(r.amount_due),
            "due_date": _day(r.due_date),
            "days_overdue": r.days_overdue,
        }
        for r in rows
    ]


async def receivables_ageing(session: AsyncSession, ws: str) -> list[dict[str, Any]]:
    v = v_receivables_ageing
    rows = await session.execute(
        select(v.c.currency, v.c.bucket, func.sum(v.c.amount_due), func.count())
        .where(_view(v, ws))
        .group_by(v.c.currency, v.c.bucket)
        .order_by(v.c.currency, v.c.bucket)
    )
    return [
        {"currency": c, "bucket": b, "amount_due": _num(total), "invoices": n}
        for c, b, total, n in rows
    ]


async def top_debtors(session: AsyncSession, ws: str, limit: int = 5) -> list[dict[str, Any]]:
    v = v_receivables_ageing
    rows = await session.execute(
        select(Client.name, v.c.currency, func.sum(v.c.amount_due).label("owed"))
        .join(Client, Client.id == v.c.client_id)
        .where(_view(v, ws), Client.workspace_id == ws)
        .group_by(Client.name, v.c.currency)
        .order_by(func.sum(v.c.amount_due).desc())
        .limit(min(limit, MAX_ROWS))
    )
    return [{"client": n, "currency": c, "amount_due": _num(o)} for n, c, o in rows]


async def gst_summary(
    session: AsyncSession, ws: str, start: date | None = None, end: date | None = None
) -> list[dict[str, Any]]:
    v = v_gst_outward_supplies
    query = select(
        v.c.gst_rate,
        func.sum(v.c.taxable_value),
        func.sum(v.c.cgst_amount),
        func.sum(v.c.sgst_amount),
        func.sum(v.c.igst_amount),
        func.sum(v.c.cess_amount),
    ).where(_view(v, ws))
    if start:
        query = query.where(v.c.issue_date >= start)
    if end:
        query = query.where(v.c.issue_date <= end)
    rows = await session.execute(query.group_by(v.c.gst_rate).order_by(v.c.gst_rate))
    return [
        {
            "gst_rate": _num(rate),
            "taxable_value": _num(taxable),
            "cgst": _num(cgst),
            "sgst": _num(sgst),
            "igst": _num(igst),
            "cess": _num(cess),
        }
        for rate, taxable, cgst, sgst, igst, cess in rows
    ]


async def list_leads(
    session: AsyncSession, ws: str, status: str | None = None, limit: int = 20
) -> list[dict[str, Any]]:
    query = scoped(Lead, ws).order_by(Lead.created_at.desc()).limit(min(limit, MAX_ROWS))
    if status:
        query = query.where(Lead.status == status)
    return [
        {
            "id": lead.id,
            "name": lead.name,
            "company": lead.company,
            "status": lead.status,
            "source": lead.source,
            "score": lead.score,
        }
        for lead in await session.scalars(query)
    ]


async def list_deals(
    session: AsyncSession, ws: str, stage: str | None = None, limit: int = 20
) -> list[dict[str, Any]]:
    query = (
        select(Deal, PipelineStage.name)
        .join(PipelineStage, PipelineStage.id == Deal.stage_id)
        .where(*workspace_filter(Deal, ws))
        .where(PipelineStage.workspace_id == ws)
        .order_by(Deal.updated_at.desc())
        .limit(min(limit, MAX_ROWS))
    )
    if stage:
        query = query.where(func.lower(PipelineStage.name) == stage.lower())
    return [
        {
            "id": deal.id,
            "title": deal.title,
            "stage": stage_name,
            "value": _num(deal.value),
            "currency": deal.currency,
        }
        for deal, stage_name in await session.execute(query)
    ]


async def get_deal(session: AsyncSession, ws: str, deal_id: str) -> dict[str, Any] | None:
    deals = await list_deals_by_id(session, ws, deal_id)
    return deals[0] if deals else None


async def list_deals_by_id(session: AsyncSession, ws: str, deal_id: str) -> list[dict[str, Any]]:
    deal = await session.scalar(scoped(Deal, ws).where(Deal.id == deal_id))
    if deal is None:
        return []
    stage = await session.scalar(
        select(PipelineStage.name).where(
            PipelineStage.id == deal.stage_id, PipelineStage.workspace_id == ws
        )
    )
    return [
        {
            "id": deal.id,
            "title": deal.title,
            "stage": stage,
            "value": _num(deal.value),
            "currency": deal.currency,
            "client_id": deal.client_id,
            "quote_id": deal.quote_id,
        }
    ]


async def get_invoice(session: AsyncSession, ws: str, invoice_id: str) -> dict[str, Any] | None:
    invoice = await session.scalar(scoped(Invoice, ws).where(Invoice.id == invoice_id))
    if invoice is None:
        return None
    client = await session.scalar(
        scoped(Client, ws).where(Client.id == invoice.client_id).with_only_columns(Client.name)
    )
    lines = await session.scalars(
        select(InvoiceLineItem)
        .where(InvoiceLineItem.invoice_id == invoice.id)
        .order_by(InvoiceLineItem.sort_order)
    )
    return {
        "id": invoice.id,
        "number": invoice.invoice_number,
        "client": client,
        "status": invoice.status,
        "currency": invoice.currency,
        "issue_date": _day(invoice.issue_date),
        "due_date": _day(invoice.due_date),
        "total": _num(invoice.total),
        "amount_paid": _num(invoice.amount_paid),
        "amount_due": _num(invoice.amount_due),
        "lines": [
            {
                "name": li.name,
                "quantity": _num(li.quantity),
                "rate": _num(li.rate),
                "amount": _num(li.amount),
                "hsn_sac": li.hsn_sac,
            }
            for li in lines
        ],
    }


async def get_quote(session: AsyncSession, ws: str, quote_id: str) -> dict[str, Any] | None:
    quote = await session.scalar(scoped(Quote, ws).where(Quote.id == quote_id))
    if quote is None:
        return None
    client = await session.scalar(
        scoped(Client, ws).where(Client.id == quote.client_id).with_only_columns(Client.name)
    )
    lines = await session.scalars(
        select(QuoteLineItem)
        .where(QuoteLineItem.quote_id == quote.id)
        .order_by(QuoteLineItem.sort_order)
    )
    return {
        "id": quote.id,
        "number": quote.quote_number,
        "title": quote.title,
        "client": client,
        "status": quote.status,
        "currency": quote.currency,
        "total": _num(quote.total),
        "lines": [
            {
                "name": li.name,
                "quantity": _num(li.quantity),
                "rate": _num(li.rate),
                "amount": _num(li.amount),
                "hsn_sac": li.hsn_sac,
            }
            for li in lines
        ],
    }


async def find_client(session: AsyncSession, ws: str, ref: str) -> dict[str, Any] | None:
    """By id, else by exact then partial name (case-insensitive)."""
    ref = ref.strip()
    if not ref:
        return None
    client = await session.scalar(scoped(Client, ws).where(Client.id == ref))
    if client is None:
        client = await session.scalar(
            scoped(Client, ws)
            .where(or_(func.lower(Client.name) == ref.lower(), Client.name.ilike(_like(ref))))
            .order_by(func.lower(Client.name) != ref.lower(), Client.name)
            .limit(1)
        )
    if client is None:
        return None
    return {
        "client_id": client.id,
        "name": client.name,
        "company": client.company,
        "state_code": client.state_code,
        "country_code": client.country_code,
        "gstin": client.gstin,
    }


async def list_rate_cards(
    session: AsyncSession, ws: str, query: str | None = None
) -> list[dict[str, Any]]:
    statement = scoped(RateCard, ws).where(RateCard.is_active.is_(True)).order_by(RateCard.name)
    if query:
        statement = statement.where(
            or_(RateCard.name.ilike(_like(query)), RateCard.description.ilike(_like(query)))
        )
    return [
        {
            "rate_card_id": card.id,
            "name": card.name,
            "description": card.description,
            "rate": _num(card.rate),
            "unit": card.unit,
            "hsn_sac": card.hsn_sac,
            "gst_rate": _num(card.gst_rate) if card.gst_rate is not None else None,
        }
        for card in await session.scalars(statement.limit(MAX_ROWS))
    ]


async def past_quotes(
    session: AsyncSession, ws: str, client_id: str | None = None, limit: int = 5
) -> list[dict[str, Any]]:
    statement = scoped(Quote, ws).order_by(Quote.created_at.desc()).limit(min(limit, 20))
    if client_id:
        statement = statement.where(Quote.client_id == client_id)
    out = []
    for quote in await session.scalars(statement):
        detail = await get_quote(session, ws, quote.id)
        if detail:
            out.append(detail)
    return out
