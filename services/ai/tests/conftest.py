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
import time
import uuid
from collections.abc import AsyncIterator
from decimal import Decimal
from pathlib import Path

import jwt
import pytest
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine

from alembic import command
from app.db.session import create_engine
from app.llm.providers import resolve_provider
from app.main import create_app
from app.services import Services, build_services
from app.settings import Settings
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


WEB_SECRET = "w" * 64
WORKER_SECRET = "k" * 64
AI_SECRET = "a" * 64


def make_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "svc_jwt_secret_web": WEB_SECRET,
        "svc_jwt_secret_worker": WORKER_SECRET,
        "svc_jwt_secret_ai": AI_SECRET,
        "daily_budget_usd": Decimal("5"),
        "provider": resolve_provider({"LLM_PROVIDER": "fake"}),
    }
    values.update(overrides)
    return Settings.model_validate(values)


def service_token(
    workspace_id: str,
    scopes: list[str],
    *,
    issuer: str = "web",
    user: str | None = "user-1",
    secret: str | None = None,
) -> str:
    now = int(time.time())
    payload: dict[str, object] = {
        "iss": issuer,
        "aud": "ai",
        "iat": now,
        "exp": now + 60,
        "jti": str(uuid.uuid4()),
        "workspaceId": workspace_id,
        "scopes": scopes,
    }
    if user:
        payload["sub"] = user
    key = secret or {"web": WEB_SECRET, "worker": WORKER_SECRET}[issuer]
    return jwt.encode(payload, key, algorithm="HS256", headers={"kid": issuer})


@pytest.fixture
async def services(migrated: AsyncEngine) -> AsyncIterator[Services]:
    built = build_services(make_settings(), engine=migrated)
    yield built
    await built.llm.aclose()


@pytest.fixture
async def client(services: Services) -> AsyncIterator[AsyncClient]:
    app = create_app(services=services)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://ai") as c:
        yield c
