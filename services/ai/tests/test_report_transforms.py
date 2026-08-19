"""Pure pandas transforms behind the nightly export."""

from __future__ import annotations

import io
from datetime import date, datetime
from decimal import Decimal

import pandas as pd
from openpyxl import load_workbook

from app.reports.transforms import (
    LEAD_FEATURE_COLUMNS,
    ageing_summary,
    gst_by_rate,
    lead_score_features,
    revenue_by_month,
    to_csv_bytes,
    to_xlsx_bytes,
)


def test_ageing_summary_pivots_buckets_per_currency() -> None:
    rows = pd.DataFrame(
        {
            "currency": ["INR", "INR", "USD", "INR"],
            "bucket": ["current", "bucket_31_60", "bucket_90_plus", "bucket_31_60"],
            "amount_due": [Decimal("100.50"), Decimal("200"), Decimal("50"), Decimal("1.25")],
        }
    )
    out = ageing_summary(rows)
    assert list(out.columns) == [
        "currency",
        "current",
        "bucket_0_30",
        "bucket_31_60",
        "bucket_61_90",
        "bucket_90_plus",
        "total",
    ]
    inr = out[out["currency"] == "INR"].iloc[0]
    assert inr["current"] == 100.50 and inr["bucket_31_60"] == 201.25
    assert inr["bucket_0_30"] == 0 and inr["total"] == 301.75
    assert out[out["currency"] == "USD"].iloc[0]["total"] == 50
    assert list(out["currency"]) == ["INR", "USD"]


def test_ageing_summary_of_nothing_has_the_columns() -> None:
    out = ageing_summary(pd.DataFrame(columns=["currency", "bucket", "amount_due"]))
    assert out.empty and "total" in out.columns


def test_revenue_by_month_sorts_and_sums() -> None:
    rows = pd.DataFrame(
        {
            "month": [date(2026, 9, 1), date(2026, 8, 1), date(2026, 9, 1)],
            "currency": ["INR", "INR", "USD"],
            "revenue": [Decimal("10"), Decimal("5"), Decimal("2")],
            "payment_count": [2, 1, 1],
        }
    )
    out = revenue_by_month(rows)
    assert out.to_dict("records") == [
        {"month": "2026-08", "currency": "INR", "revenue": 5.0, "payment_count": 1},
        {"month": "2026-09", "currency": "INR", "revenue": 10.0, "payment_count": 2},
        {"month": "2026-09", "currency": "USD", "revenue": 2.0, "payment_count": 1},
    ]


def test_gst_by_rate_totals_taxes() -> None:
    rows = pd.DataFrame(
        {
            "gst_rate": [Decimal("18"), Decimal("18"), Decimal("5")],
            "taxable_value": [Decimal("100"), Decimal("200"), Decimal("1000")],
            "cgst_amount": [Decimal("9"), Decimal("0"), Decimal("25")],
            "sgst_amount": [Decimal("9"), Decimal("0"), Decimal("25")],
            "igst_amount": [Decimal("0"), Decimal("36"), Decimal("0")],
            "cess_amount": [Decimal("0"), Decimal("0"), Decimal("0")],
        }
    )
    out = gst_by_rate(rows)
    assert out.to_dict("records") == [
        {
            "gst_rate": 5.0,
            "taxable_value": 1000.0,
            "cgst": 25.0,
            "sgst": 25.0,
            "igst": 0.0,
            "cess": 0.0,
            "total_tax": 50.0,
        },
        {
            "gst_rate": 18.0,
            "taxable_value": 300.0,
            "cgst": 9.0,
            "sgst": 9.0,
            "igst": 36.0,
            "cess": 0.0,
            "total_tax": 54.0,
        },
    ]


def test_lead_score_features() -> None:
    now = datetime(2026, 10, 3, 12, 0)
    leads = pd.DataFrame(
        {
            "id": ["l1", "l2"],
            "email": ["a@x.dev", None],
            "phone": [None, "+919999999999"],
            "company": ["Acme", ""],
            "source": ["widget", "manual"],
            "status": ["converted", "new"],
            "message": ["Need a website redesign quickly", None],
            "created_at": [datetime(2026, 9, 3, 12, 0), datetime(2026, 10, 2, 12, 0)],
        }
    )
    deals = pd.DataFrame({"lead_id": ["l1"], "value": [Decimal("90000")]})
    out = lead_score_features(leads, deals, now)
    assert list(out.columns) == LEAD_FEATURE_COLUMNS
    l1, l2 = out.set_index("lead_id").loc["l1"], out.set_index("lead_id").loc["l2"]
    assert (l1["has_email"], l1["has_phone"], l1["has_company"]) == (1, 0, 1)
    assert (l2["has_email"], l2["has_phone"], l2["has_company"]) == (0, 1, 0)
    assert l1["message_words"] == 5 and l2["message_words"] == 0
    assert l1["age_days"] == 30.0 and l2["age_days"] == 1.0
    assert l1["source_widget"] == 1 and l1["source_manual"] == 0 and l2["source_manual"] == 1
    assert (l1["has_deal"], l1["deal_value"]) == (1, 90000.0)
    assert (l2["has_deal"], l2["deal_value"]) == (0, 0.0)
    assert (l1["converted"], l2["converted"]) == (1, 0)


def test_csv_and_xlsx_bytes() -> None:
    frame = pd.DataFrame({"a": [1, 2], "b": ["x", "y"]})
    assert to_csv_bytes(frame) == b"a,b\n1,x\n2,y\n"
    book = load_workbook(io.BytesIO(to_xlsx_bytes({"First": frame, "Second": frame.head(1)})))
    assert book.sheetnames == ["First", "Second"]
    assert [c.value for c in book["First"][1]] == ["a", "b"]
    assert book["Second"].max_row == 2
