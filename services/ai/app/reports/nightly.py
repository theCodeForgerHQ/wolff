"""The nightly report export (job reports.nightly).

Reads the report views (owned by Prisma migrations, the single source of
report numbers) and the leads table for the caller's workspace, builds
the frames with pandas, writes one XLSX workbook and an ageing CSV, and
records a report_snapshots row per (workspace, kind, period). Running it
twice for one period overwrites the files and the row.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ReportSnapshot
from app.db.public_models import (
    Deal,
    Lead,
    v_gst_outward_supplies,
    v_receivables_ageing,
    v_revenue_monthly,
)
from app.db.scoped import scoped
from app.reports.transforms import (
    ageing_summary,
    gst_by_rate,
    lead_score_features,
    revenue_by_month,
    to_csv_bytes,
    to_xlsx_bytes,
)

KIND = "nightly"


class Storage(Protocol):
    async def put(self, key: str, body: bytes) -> None: ...


class LocalStorage:
    def __init__(self, root: str) -> None:
        self._root = Path(root)

    async def put(self, key: str, body: bytes) -> None:
        path = (self._root / key).resolve()
        if self._root.resolve() not in path.parents:
            raise ValueError("report key escapes the reports directory")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)


@dataclass(frozen=True)
class Frames:
    ageing: pd.DataFrame
    revenue: pd.DataFrame
    gst: pd.DataFrame
    lead_features: pd.DataFrame


async def _frame(session: AsyncSession, statement: Any) -> pd.DataFrame:
    result = await session.execute(statement)
    return pd.DataFrame(result.mappings().all(), columns=list(result.keys()))


async def load_frames(session: AsyncSession, ws: str, now: datetime) -> Frames:
    if not ws:
        raise ValueError("a workspace is required")
    ra, rm, gst = v_receivables_ageing, v_revenue_monthly, v_gst_outward_supplies
    ageing = await _frame(
        session, select(ra.c.currency, ra.c.bucket, ra.c.amount_due).where(ra.c.workspace_id == ws)
    )
    revenue = await _frame(
        session,
        select(rm.c.month, rm.c.currency, rm.c.revenue, rm.c.payment_count).where(
            rm.c.workspace_id == ws
        ),
    )
    gst_rows = await _frame(
        session,
        select(
            gst.c.gst_rate,
            gst.c.taxable_value,
            gst.c.cgst_amount,
            gst.c.sgst_amount,
            gst.c.igst_amount,
            gst.c.cess_amount,
        ).where(gst.c.workspace_id == ws),
    )
    leads = await _frame(
        session,
        scoped(Lead, ws).with_only_columns(
            Lead.id,
            Lead.email,
            Lead.phone,
            Lead.company,
            Lead.source,
            Lead.status,
            Lead.message,
            Lead.created_at,
        ),
    )
    deals = await _frame(
        session,
        scoped(Deal, ws)
        .where(Deal.lead_id.is_not(None))
        .with_only_columns(Deal.lead_id, Deal.value),
    )
    return Frames(
        ageing=ageing_summary(ageing),
        revenue=revenue_by_month(revenue) if not revenue.empty else revenue,
        gst=gst_by_rate(gst_rows) if not gst_rows.empty else gst_rows,
        lead_features=lead_score_features(leads, deals, now.replace(tzinfo=None)),
    )


def default_period(now: datetime) -> str:
    """The day the nightly run reports on: yesterday, UTC."""
    return (now.date() - timedelta(days=1)).isoformat()


async def run_nightly(
    session: AsyncSession,
    storage: Storage,
    ws: str,
    *,
    now: datetime | None = None,
    period: str | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    period = period or default_period(now)
    date.fromisoformat(period)  # rejects anything that is not a date
    frames = await load_frames(session, ws, now)
    base = f"reports/{ws}/{KIND}/{period}"
    await storage.put(
        f"{base}.xlsx",
        to_xlsx_bytes(
            {
                "Receivables ageing": frames.ageing,
                "Revenue by month": frames.revenue,
                "GST by rate": frames.gst,
                "Lead features": frames.lead_features,
            }
        ),
    )
    await storage.put(f"{base}-ageing.csv", to_csv_bytes(frames.ageing))
    summary = {
        "outstanding": {row["currency"]: row["total"] for row in frames.ageing.to_dict("records")},
        "leads": len(frames.lead_features),
        "gst_rates": len(frames.gst),
    }
    statement = insert(ReportSnapshot).values(
        workspace_id=ws, kind=KIND, period=period, s3_key=f"{base}.xlsx", summary=summary
    )
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=[
                ReportSnapshot.workspace_id,
                ReportSnapshot.kind,
                ReportSnapshot.period,
            ],
            set_={"s3_key": statement.excluded.s3_key, "summary": statement.excluded.summary},
        )
    )
    await session.commit()
    return {"period": period, "key": f"{base}.xlsx", "summary": summary}
