"""Pure pandas transforms for the nightly export and the lead-score
features. Their numbers must equal the SQL views' (checked in
tests/test_reports.py against the views)."""

from __future__ import annotations

import io
from datetime import datetime

import pandas as pd

BUCKETS = ["current", "bucket_0_30", "bucket_31_60", "bucket_61_90", "bucket_90_plus"]
SOURCES = ["manual", "widget", "api", "import"]
LEAD_FEATURE_COLUMNS = [
    "lead_id",
    "has_email",
    "has_phone",
    "has_company",
    "message_words",
    "age_days",
    *(f"source_{s}" for s in SOURCES),
    "has_deal",
    "deal_value",
    "converted",
]


def _float(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series.map(lambda v: float(v) if v is not None else 0.0))


def ageing_summary(rows: pd.DataFrame) -> pd.DataFrame:
    columns = ["currency", *BUCKETS, "total"]
    if rows.empty:
        return pd.DataFrame(columns=columns)
    frame = rows.assign(amount_due=_float(rows["amount_due"]))
    pivot = frame.pivot_table(
        index="currency", columns="bucket", values="amount_due", aggfunc="sum", fill_value=0.0
    ).reindex(columns=BUCKETS, fill_value=0.0)
    pivot["total"] = pivot[BUCKETS].sum(axis=1)
    out = pivot.round(2).reset_index().sort_values("currency", ignore_index=True)
    out.columns.name = None
    return out[columns]


def revenue_by_month(rows: pd.DataFrame) -> pd.DataFrame:
    frame = rows.assign(
        month=pd.to_datetime(rows["month"]).dt.strftime("%Y-%m"),
        revenue=_float(rows["revenue"]),
        payment_count=rows["payment_count"].astype(int),
    )
    out = (
        frame.groupby(["month", "currency"], as_index=False)[["revenue", "payment_count"]]
        .sum()
        .sort_values(["month", "currency"], ignore_index=True)
    )
    out["revenue"] = out["revenue"].round(2)
    out["payment_count"] = out["payment_count"].astype(int)
    return out[["month", "currency", "revenue", "payment_count"]]


def gst_by_rate(rows: pd.DataFrame) -> pd.DataFrame:
    names = {
        "taxable_value": "taxable_value",
        "cgst_amount": "cgst",
        "sgst_amount": "sgst",
        "igst_amount": "igst",
        "cess_amount": "cess",
    }
    frame = pd.DataFrame({"gst_rate": _float(rows["gst_rate"])})
    for source, target in names.items():
        frame[target] = _float(rows[source])
    out = frame.groupby("gst_rate", as_index=False).sum().sort_values("gst_rate")
    out["total_tax"] = out[["cgst", "sgst", "igst", "cess"]].sum(axis=1)
    return out.round(2).reset_index(drop=True)


def _present(series: pd.Series) -> pd.Series:
    return series.map(lambda v: int(isinstance(v, str) and bool(v.strip())))


def lead_score_features(leads: pd.DataFrame, deals: pd.DataFrame, now: datetime) -> pd.DataFrame:
    values = (
        deals.assign(value=_float(deals["value"])).groupby("lead_id")["value"].sum()
        if not deals.empty
        else pd.Series(dtype=float)
    )
    out = pd.DataFrame({"lead_id": leads["id"]})
    out["has_email"] = _present(leads["email"])
    out["has_phone"] = _present(leads["phone"])
    out["has_company"] = _present(leads["company"])
    out["message_words"] = leads["message"].map(
        lambda m: len(m.split()) if isinstance(m, str) else 0
    )
    created = pd.to_datetime(leads["created_at"])
    out["age_days"] = ((pd.Timestamp(now) - created).dt.total_seconds() / 86_400).round(1)
    for source in SOURCES:
        out[f"source_{source}"] = (leads["source"] == source).astype(int)
    out["has_deal"] = leads["id"].isin(values.index).astype(int)
    out["deal_value"] = leads["id"].map(values).fillna(0.0).astype(float)
    out["converted"] = (leads["status"] == "converted").astype(int)
    return out[LEAD_FEATURE_COLUMNS].reset_index(drop=True)


def to_csv_bytes(frame: pd.DataFrame) -> bytes:
    return frame.to_csv(index=False, lineterminator="\n").encode("utf-8")


def to_xlsx_bytes(sheets: dict[str, pd.DataFrame]) -> bytes:
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        for name, frame in sheets.items():
            frame.to_excel(writer, sheet_name=name, index=False)
    return buffer.getvalue()
