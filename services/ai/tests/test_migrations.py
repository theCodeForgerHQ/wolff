"""Alembic owns the ``ai`` schema: the migrations must create
exactly what the models describe, and touch nothing outside ``ai``."""

from __future__ import annotations

import asyncio

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from alembic import command
from app.db.alembic_filter import include_name, include_object
from app.db.models import AiBase
from app.db.session import async_url, create_engine
from tests.conftest import DB_URL, alembic_config, requires_db

AI_TABLES = {
    "alembic_version",
    "document_chunks",
    "ingest_state",
    "chat_sessions",
    "chat_messages",
    "agent_runs",
    "usage_daily",
    "eval_runs",
    "report_snapshots",
}


@requires_db
@pytest.mark.usefixtures("migrated")
async def test_migrations_match_the_models() -> None:
    def diff(conn: Connection) -> list[object]:
        context = MigrationContext.configure(
            conn,
            opts={
                "include_schemas": True,
                "include_name": include_name,
                "include_object": include_object,
                "version_table_schema": "ai",
            },
        )
        return list(compare_metadata(context, AiBase.metadata))

    # Connect as Alembic does, without the service's `ai,public` search path:
    # with `ai` as the default schema, reflection would report references
    # inside `ai` unqualified and differ from the models.
    plain = create_async_engine(async_url(DB_URL))
    try:
        async with plain.connect() as conn:
            assert await conn.run_sync(diff) == []
    finally:
        await plain.dispose()


@requires_db
async def test_head_creates_the_ai_tables_owned_by_ai_owner(migrated: AsyncEngine) -> None:
    async with migrated.connect() as conn:
        tables = await conn.run_sync(lambda c: set(inspect(c).get_table_names("ai")))
        owners = await conn.scalars(
            text("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'ai'")
        )
        assert tables == AI_TABLES
        assert set(owners) == {"ai_owner"}


@requires_db
async def test_downgrade_removes_only_ai_tables_and_upgrade_restores_them(
    migrated: AsyncEngine,
) -> None:
    config = alembic_config(DB_URL)
    async with migrated.connect() as conn:
        public_before = await conn.run_sync(lambda c: set(inspect(c).get_table_names("public")))
    await asyncio.to_thread(command.downgrade, config, "base")
    try:
        async with migrated.connect() as conn:
            ai_after = await conn.run_sync(lambda c: set(inspect(c).get_table_names("ai")))
            public_after = await conn.run_sync(lambda c: set(inspect(c).get_table_names("public")))
        assert ai_after == {"alembic_version"}
        assert public_after == public_before
    finally:
        await asyncio.to_thread(command.upgrade, config, "head")


@requires_db
async def test_a_libpq_style_url_connects_through_asyncpg() -> None:
    """One URL serves Alembic (psycopg) and the service (asyncpg)."""
    separator = "&" if "?" in DB_URL else "?"
    engine = create_engine(DB_URL + separator + "sslmode=disable&channel_binding=disable")
    try:
        async with engine.connect() as connection:
            assert (await connection.execute(text("SELECT 1"))).scalar_one() == 1
    finally:
        await engine.dispose()
