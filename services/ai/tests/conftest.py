"""Fixtures. Suites that need Postgres skip unless both URLs are set.

AI_TEST_DATABASE_URL       the ai_service login (what the service uses)
AI_TEST_ADMIN_DATABASE_URL the database owner, to seed ``public`` rows,
                           which ai_service itself cannot write
Both point at one database that has had ``prisma migrate deploy`` and
infra/db/bootstrap.sql.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from alembic.config import Config
from sqlalchemy.ext.asyncio import AsyncEngine

from alembic import command
from app.db.session import create_engine
from tests.seed import Seeded, seed_workspace

SERVICE_ROOT = Path(__file__).resolve().parent.parent
DB_URL = os.environ.get("AI_TEST_DATABASE_URL", "")
ADMIN_URL = os.environ.get("AI_TEST_ADMIN_DATABASE_URL", "")

requires_db = pytest.mark.skipif(
    not (DB_URL and ADMIN_URL),
    reason="AI_TEST_DATABASE_URL and AI_TEST_ADMIN_DATABASE_URL are not set",
)


@pytest.fixture(scope="session")
async def engine() -> AsyncIterator[AsyncEngine]:
    """The service's own connection (ai_service)."""
    created = create_engine(DB_URL)
    yield created
    await created.dispose()


@pytest.fixture(scope="session")
async def admin_engine() -> AsyncIterator[AsyncEngine]:
    """The owner's connection, for test data in ``public``."""
    created = create_engine(ADMIN_URL)
    yield created
    await created.dispose()


def alembic_config(url: str) -> Config:
    """Alembic pointed at ``url`` (sync psycopg driver)."""
    config = Config(str(SERVICE_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
    config.attributes["database_url"] = url
    return config


@pytest.fixture(scope="session")
async def migrated(engine: AsyncEngine) -> AsyncEngine:
    """The service's engine after ``alembic upgrade head``."""
    await asyncio.to_thread(command.upgrade, alembic_config(DB_URL), "head")
    return engine


@pytest.fixture(scope="session")
async def ws_a(admin_engine: AsyncEngine) -> Seeded:
    return await seed_workspace(admin_engine, "a")


@pytest.fixture(scope="session")
async def ws_b(admin_engine: AsyncEngine) -> Seeded:
    return await seed_workspace(admin_engine, "b")
