"""Async database access: one engine per process, asyncpg."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def async_url(url: str) -> str:
    """Accept a plain ``postgresql://`` URL and select the asyncpg driver."""
    for prefix in ("postgresql+asyncpg://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url.removeprefix(prefix)
    raise ValueError("AI_DATABASE_URL must be a postgresql:// URL")


def create_engine(url: str) -> AsyncEngine:
    """Engine whose connections see ``ai`` first, then ``public``.

    The statement cache is off because the free demo connects through a
    transaction-mode pooler (Neon), where prepared statements break.
    """
    return create_async_engine(
        async_url(url),
        pool_pre_ping=True,
        connect_args={
            "statement_cache_size": 0,
            "server_settings": {"search_path": "ai,public"},
        },
    )


def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Sessions that keep loaded values after commit."""
    return async_sessionmaker(engine, expire_on_commit=False)
