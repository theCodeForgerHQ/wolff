"""Public schema models mirrored from Prisma.

These mirror Prisma @@map/@map names; only the columns the AI service reads;
tests/test_schema_contract.py fails CI when they drift.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    ARRAY,
    Boolean,
    Column,
    Date,
    DateTime,
    Integer,
    MetaData,
    Numeric,
    String,
    Table,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class PublicBase(DeclarativeBase):
    """Base for all public-schema tables."""

    metadata = MetaData(schema="public")


class Workspace(PublicBase):
    """workspaces table."""

    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    slug: Mapped[str] = mapped_column(String)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class WorkspaceMember(PublicBase):
    """workspace_members table."""

    __tablename__ = "workspace_members"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    user_id: Mapped[str] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)


class BusinessProfile(PublicBase):
    """business_profiles table. Primary key is workspace_id."""

    __tablename__ = "business_profiles"

    workspace_id: Mapped[str] = mapped_column(String, primary_key=True)
    business_name: Mapped[str] = mapped_column(String)
    gstin: Mapped[str | None] = mapped_column(String, nullable=True)
    state_code: Mapped[str | None] = mapped_column(String, nullable=True)
    currency: Mapped[str] = mapped_column(String)
    gst_registration_type: Mapped[str] = mapped_column(String)


class Client(PublicBase):
    """clients table."""

    __tablename__ = "clients"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    company: Mapped[str | None] = mapped_column(String, nullable=True)
    email: Mapped[str] = mapped_column(String)
    gstin: Mapped[str | None] = mapped_column(String, nullable=True)
    state_code: Mapped[str | None] = mapped_column(String, nullable=True)
    country_code: Mapped[str] = mapped_column(String)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class Quote(PublicBase):
    """quotes table."""

    __tablename__ = "quotes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    client_id: Mapped[str] = mapped_column(String)
    quote_number: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    issue_date: Mapped[date] = mapped_column(Date)
    expiration_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    subtotal: Mapped[Decimal] = mapped_column(Numeric)
    tax_total: Mapped[Decimal] = mapped_column(Numeric)
    total: Mapped[Decimal] = mapped_column(Numeric)
    currency: Mapped[str] = mapped_column(String)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
    terms: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class QuoteLineItem(PublicBase):
    """quote_line_items table."""

    __tablename__ = "quote_line_items"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    quote_id: Mapped[str] = mapped_column(String)
    rate_card_id: Mapped[str | None] = mapped_column(String, nullable=True)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric)
    rate: Mapped[Decimal] = mapped_column(Numeric)
    amount: Mapped[Decimal] = mapped_column(Numeric)
    hsn_sac: Mapped[str | None] = mapped_column(String, nullable=True)
    item_type: Mapped[str] = mapped_column(String)
    gst_rate: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer)


class Invoice(PublicBase):
    """invoices table."""

    __tablename__ = "invoices"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    client_id: Mapped[str] = mapped_column(String)
    quote_id: Mapped[str | None] = mapped_column(String, nullable=True)
    invoice_number: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    issue_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date)
    subtotal: Mapped[Decimal] = mapped_column(Numeric)
    tax_total: Mapped[Decimal] = mapped_column(Numeric)
    total: Mapped[Decimal] = mapped_column(Numeric)
    amount_paid: Mapped[Decimal] = mapped_column(Numeric)
    amount_due: Mapped[Decimal] = mapped_column(Numeric)
    currency: Mapped[str] = mapped_column(String)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
    terms: Mapped[str | None] = mapped_column(String, nullable=True)
    place_of_supply: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class InvoiceLineItem(PublicBase):
    """invoice_line_items table."""

    __tablename__ = "invoice_line_items"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    invoice_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric)
    rate: Mapped[Decimal] = mapped_column(Numeric)
    amount: Mapped[Decimal] = mapped_column(Numeric)
    hsn_sac: Mapped[str | None] = mapped_column(String, nullable=True)
    gst_rate: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    taxable_value: Mapped[Decimal] = mapped_column(Numeric)
    cgst_amount: Mapped[Decimal] = mapped_column(Numeric)
    sgst_amount: Mapped[Decimal] = mapped_column(Numeric)
    igst_amount: Mapped[Decimal] = mapped_column(Numeric)
    sort_order: Mapped[int] = mapped_column(Integer)


class Contract(PublicBase):
    """contracts table."""

    __tablename__ = "contracts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    content: Mapped[str] = mapped_column(String)
    is_template: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class ContractInstance(PublicBase):
    """contract_instances table."""

    __tablename__ = "contract_instances"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    contract_id: Mapped[str | None] = mapped_column(String, nullable=True)
    quote_id: Mapped[str | None] = mapped_column(String, nullable=True)
    client_id: Mapped[str | None] = mapped_column(String, nullable=True)
    content: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String)
    signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class RateCard(PublicBase):
    """rate_cards table."""

    __tablename__ = "rate_cards"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    pricing_type: Mapped[str] = mapped_column(String)
    rate: Mapped[Decimal] = mapped_column(Numeric)
    unit: Mapped[str | None] = mapped_column(String, nullable=True)
    hsn_sac: Mapped[str | None] = mapped_column(String, nullable=True)
    item_type: Mapped[str] = mapped_column(String)
    gst_rate: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class Lead(PublicBase):
    """leads table."""

    __tablename__ = "leads"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[str | None] = mapped_column(String, nullable=True)
    phone: Mapped[str | None] = mapped_column(String, nullable=True)
    company: Mapped[str | None] = mapped_column(String, nullable=True)
    source: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String)
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message: Mapped[str | None] = mapped_column(String, nullable=True)
    client_id: Mapped[str | None] = mapped_column(String, nullable=True)
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class Deal(PublicBase):
    """deals table."""

    __tablename__ = "deals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    pipeline_id: Mapped[str] = mapped_column(String)
    stage_id: Mapped[str] = mapped_column(String)
    lead_id: Mapped[str | None] = mapped_column(String, nullable=True)
    client_id: Mapped[str | None] = mapped_column(String, nullable=True)
    title: Mapped[str] = mapped_column(String)
    value: Mapped[Decimal] = mapped_column(Numeric)
    currency: Mapped[str] = mapped_column(String)
    expected_close_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    quote_id: Mapped[str | None] = mapped_column(String, nullable=True)
    won_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    lost_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class Pipeline(PublicBase):
    """pipelines table."""

    __tablename__ = "pipelines"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    is_default: Mapped[bool] = mapped_column(Boolean)


class PipelineStage(PublicBase):
    """pipeline_stages table."""

    __tablename__ = "pipeline_stages"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    pipeline_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    position: Mapped[int] = mapped_column(Integer)
    probability: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String)


class ApiKey(PublicBase):
    """api_keys table."""

    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    key_hash: Mapped[str] = mapped_column(String)
    key_prefix: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)
    scopes: Mapped[list[str]] = mapped_column(ARRAY(String))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class Payment(PublicBase):
    """payments table."""

    __tablename__ = "payments"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String)
    invoice_id: Mapped[str] = mapped_column(String)
    amount: Mapped[Decimal] = mapped_column(Numeric)
    currency: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


# Separate metadata for views so they are not in PublicBase.metadata
views_metadata = MetaData(schema="public")

v_receivables_ageing = Table(
    "v_receivables_ageing",
    views_metadata,
    Column("workspace_id", String),
    Column("invoice_id", String),
    Column("client_id", String),
    Column("invoice_number", String),
    Column("currency", String),
    Column("total", Numeric),
    Column("amount_due", Numeric),
    Column("due_date", Date),
    Column("days_overdue", Integer),
    Column("bucket", String),
    schema="public",
)

v_revenue_monthly = Table(
    "v_revenue_monthly",
    views_metadata,
    Column("workspace_id", String),
    Column("month", Date),
    Column("currency", String),
    Column("revenue", Numeric),
    Column("payment_count", Integer),  # BigInteger maps to Integer in Python
    schema="public",
)

v_gst_outward_supplies = Table(
    "v_gst_outward_supplies",
    views_metadata,
    Column("workspace_id", String),
    Column("invoice_id", String),
    Column("invoice_number", String),
    Column("issue_date", Date),
    Column("supply_type", String),
    Column("reverse_charge", Boolean),
    Column("supplier_gstin", String),
    Column("recipient_gstin", String),
    Column("hsn_sac", String),
    Column("gst_rate", Numeric),
    Column("taxable_value", Numeric),
    Column("cgst_amount", Numeric),
    Column("sgst_amount", Numeric),
    Column("igst_amount", Numeric),
    Column("cess_amount", Numeric),
    Column("line_total", Numeric),
    schema="public",
)

v_pipeline_stage_transitions = Table(
    "v_pipeline_stage_transitions",
    views_metadata,
    Column("workspace_id", String),
    Column("deal_id", String),
    Column("title", String),
    Column("value", Numeric),
    Column("currency", String),
    Column("pipeline_id", String),
    Column("pipeline_name", String),
    Column("stage_id", String),
    Column("stage_name", String),
    Column("stage_position", Integer),
    Column("stage_kind", String),
    Column("probability", Integer),
    Column("deal_created_at", DateTime(timezone=False)),
    Column("won_at", DateTime(timezone=False)),
    Column("lost_at", DateTime(timezone=False)),
    schema="public",
)

# Module-level tuple of view tables
public_views: tuple[Table, ...] = (
    v_receivables_ageing,
    v_revenue_monthly,
    v_gst_outward_supplies,
    v_pipeline_stage_transitions,
)
