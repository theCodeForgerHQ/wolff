"""Fixtures. Suites that need Postgres skip unless both URLs are set.

AI_TEST_DATABASE_URL       the ai_service login (what the service uses)
AI_TEST_ADMIN_DATABASE_URL the database owner, to seed ``public`` rows,
                           which ai_service itself cannot write
Both point at one database that has had ``prisma migrate deploy`` and
infra/db/bootstrap.sql.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.session import create_engine

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
