"""Structured output of the quote agent.

Shaped for OpenAI strict json_schema: every field present, optional ones
nullable, no extra keys. Bounds are checked here and again by apps/api.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class DraftLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    description: str | None
    qty: float = Field(gt=0, le=1_000_000)
    unit: str | None
    rate: float = Field(ge=0, le=1e10)
    hsn_sac: str | None = Field(max_length=8)
    source: Literal["rate_card", "past_quote", "new"]
    source_ref: str | None


class QuoteDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: str
    deal_id: str | None
    title: str = Field(min_length=1, max_length=300)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    line_items: list[DraftLine] = Field(min_length=1, max_length=50)
    terms: str | None
    notes: str | None
    assumptions: list[str]
    confidence: float = Field(ge=0, le=1)
