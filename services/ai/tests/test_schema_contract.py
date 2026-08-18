"""Every column the AI service maps must exist in the
database Prisma migrated, with a compatible type. Fails when Prisma renames
or retypes something the service reads."""

from __future__ import annotations

from sqlalchemy import Column, MetaData, Numeric, String, Table, inspect
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.public_models import PublicBase, public_views
from tests.conftest import requires_db
from tests.schema_check import schema_problems

EXPECTED_TABLES = {
    "workspaces",
    "workspace_members",
    "business_profiles",
    "clients",
    "quotes",
    "quote_line_items",
    "invoices",
    "invoice_line_items",
    "contracts",
    "contract_instances",
    "rate_cards",
    "leads",
    "deals",
    "pipelines",
    "pipeline_stages",
    "api_keys",
    "payments",
}
# Scoped through their parent's workspace: no workspace_id column.
PARENT_SCOPED = {"quote_line_items", "invoice_line_items"}
EXPECTED_VIEWS = {
    "v_receivables_ageing",
    "v_revenue_monthly",
    "v_gst_outward_supplies",
    "v_pipeline_stage_transitions",
}


def test_models_cover_the_tables_and_views_the_service_reads() -> None:
    assert set(PublicBase.metadata.tables) == {f"public.{t}" for t in EXPECTED_TABLES}
    assert {v.name for v in public_views} == EXPECTED_VIEWS
    for table in [*PublicBase.metadata.tables.values(), *public_views]:
        assert table.schema == "public", table.name
        if table.name in PARENT_SCOPED:
            assert "workspace_id" not in table.c, table.name
        else:
            assert "workspace_id" in table.c or table.name == "workspaces", table.name


@requires_db
async def test_every_mapped_column_exists_with_a_compatible_type(engine: AsyncEngine) -> None:
    def check(conn: Connection) -> list[str]:
        return schema_problems(inspect(conn), [*PublicBase.metadata.tables.values(), *public_views])

    async with engine.connect() as conn:
        assert await conn.run_sync(check) == []


@requires_db
async def test_the_check_reports_renamed_and_retyped_columns(engine: AsyncEngine) -> None:
    """Proves the contract test can fail."""
    metadata = MetaData()
    wrong = Table(
        "quotes",
        metadata,
        Column("id", String, primary_key=True),
        Column("quote_no", String),  # renamed
        Column("title", Numeric),  # retyped
        schema="public",
    )
    missing = Table("quotez", metadata, Column("id", String), schema="public")

    def check(conn: Connection) -> list[str]:
        return schema_problems(inspect(conn), [wrong, missing])

    async with engine.connect() as conn:
        problems = await conn.run_sync(check)
    assert problems == [
        "public.quotes.quote_no: column missing",
        "public.quotes.title: mapped NUMERIC, database has TEXT",
        "public.quotez: table or view missing",
    ]
