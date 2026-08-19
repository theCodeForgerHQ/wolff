"""The pandas export equals the SQL views, plus golden files."""

from __future__ import annotations

import io
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest
from httpx import AsyncClient
from openpyxl import load_workbook
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.models import ReportSnapshot
from app.db.public_models import v_gst_outward_supplies as gst
from app.db.public_models import v_receivables_ageing as ra
from app.db.session import session_factory
from app.reports.nightly import LocalStorage, load_frames, run_nightly
from tests.conftest import requires_db, service_token
from tests.seed import Seeded

GOLDEN = Path(__file__).parent / "golden"
NOW = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)


@requires_db
async def test_pandas_totals_equal_the_views(migrated: AsyncEngine, ws_a: Seeded) -> None:
    ws = ws_a.workspace_id
    async with session_factory(migrated)() as s:
        frames = await load_frames(s, ws, NOW)
        sql_ageing: dict[str, Decimal] = dict(
            (
                await s.execute(
                    select(ra.c.bucket, func.sum(ra.c.amount_due))
                    .where(ra.c.workspace_id == ws)
                    .group_by(ra.c.bucket)
                )
            ).all()
        )
        sql_cgst = await s.scalar(
            select(func.sum(gst.c.cgst_amount)).where(gst.c.workspace_id == ws)
        )
    row = frames.ageing.iloc[0]
    for bucket, amount in sql_ageing.items():
        assert row[bucket] == float(amount)
    assert row["total"] == float(sum(sql_ageing.values()))
    assert frames.gst["cgst"].sum() == float(sql_cgst or 0)


@requires_db
async def test_ageing_matches_the_golden_file(migrated: AsyncEngine, ws_a: Seeded) -> None:
    async with session_factory(migrated)() as s:
        frames = await load_frames(s, ws_a.workspace_id, NOW)
    golden = pd.read_csv(GOLDEN / "ageing_workspace_a.csv")
    pd.testing.assert_frame_equal(frames.ageing.reset_index(drop=True), golden, check_dtype=False)
    features = frames.lead_features.drop(columns=["lead_id", "age_days"])
    golden_features = pd.read_csv(GOLDEN / "lead_features_workspace_a.csv")
    pd.testing.assert_frame_equal(features, golden_features, check_dtype=False)


@requires_db
async def test_nightly_writes_files_and_one_snapshot_per_period(
    migrated: AsyncEngine, ws_a: Seeded, ws_b: Seeded, tmp_path: Path
) -> None:
    storage = LocalStorage(str(tmp_path))
    for _ in range(2):
        async with session_factory(migrated)() as s:
            result = await run_nightly(s, storage, ws_a.workspace_id, now=NOW)
    assert result["period"] == "2026-10-02"
    book = load_workbook(io.BytesIO((tmp_path / result["key"]).read_bytes()))
    assert book.sheetnames == [
        "Receivables ageing",
        "Revenue by month",
        "GST by rate",
        "Lead features",
    ]
    csv = (tmp_path / f"reports/{ws_a.workspace_id}/nightly/2026-10-02-ageing.csv").read_text()
    assert "90000.0" in csv and "Bluefin" not in csv
    async with session_factory(migrated)() as s:
        rows = list(
            await s.scalars(
                select(ReportSnapshot).where(ReportSnapshot.workspace_id == ws_a.workspace_id)
            )
        )
    assert len(rows) == 1 and rows[0].summary["outstanding"] == {"INR": 90000.0}


async def test_storage_refuses_keys_outside_its_directory(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="escapes"):
        await LocalStorage(str(tmp_path / "r")).put("../x.csv", b"")


@requires_db
async def test_endpoint_needs_a_worker_token_with_reports_run(
    client: AsyncClient, ws_a: Seeded, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from app.services import Services

    svc: Services = client._transport.app.state.services  # type: ignore[attr-defined]
    monkeypatch.setattr(
        svc, "settings", svc.settings.model_copy(update={"reports_dir": str(tmp_path)})
    )
    ok_token = service_token(ws_a.workspace_id, ["reports:run"], issuer="worker", user=None)
    web_token = service_token(ws_a.workspace_id, ["reports:run"])
    r = await client.post(
        "/internal/reports/nightly",
        json={"period": "2026-10-01"},
        headers={"authorization": f"Bearer {ok_token}"},
    )
    assert r.status_code == 200, r.text
    assert (tmp_path / f"reports/{ws_a.workspace_id}/nightly/2026-10-01.xlsx").exists()
    r = await client.post(
        "/internal/reports/nightly", json={}, headers={"authorization": f"Bearer {web_token}"}
    )
    assert r.status_code == 401
    bad = service_token(ws_a.workspace_id, ["reports:run"], issuer="worker", user=None)
    r = await client.post(
        "/internal/reports/nightly",
        json={"period": "../../etc"},
        headers={"authorization": f"Bearer {bad}"},
    )
    assert r.status_code == 422
