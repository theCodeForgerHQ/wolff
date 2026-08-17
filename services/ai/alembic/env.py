"""Alembic environment for the ``ai`` schema.

Runs with the sync psycopg driver as the ai_service login and switches to
ai_owner first, so every table it creates is owned by ai_owner. The schema
itself is created by a Prisma migration.
"""

from __future__ import annotations

import os

from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from alembic import context
from app.db.alembic_filter import include_name, include_object
from app.db.models import AiBase

config = context.config


def database_url() -> str:
    url = config.attributes.get("database_url") or os.environ.get("AI_DATABASE_URL", "")
    if not url:
        raise RuntimeError("AI_DATABASE_URL is not set")
    for prefix in (
        "postgresql+asyncpg://",
        "postgresql+psycopg://",
        "postgresql://",
        "postgres://",
    ):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url.removeprefix(prefix)
    raise RuntimeError("AI_DATABASE_URL must be a postgresql:// URL")


def run_migrations_online() -> None:
    engine = create_engine(database_url(), poolclass=NullPool)
    with engine.connect() as connection:
        connection.execute(text("SET ROLE ai_owner"))
        context.configure(
            connection=connection,
            target_metadata=AiBase.metadata,
            include_schemas=True,
            include_name=include_name,
            include_object=include_object,
            version_table_schema="ai",
        )
        with context.begin_transaction():
            context.run_migrations()
        connection.commit()


if context.is_offline_mode():
    raise NotImplementedError("offline migrations are not supported")
run_migrations_online()
