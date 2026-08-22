"""Async database access: one engine per process, asyncpg."""

from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# libpq-only query parameters that asyncpg rejects as unknown keywords.
# asyncpg negotiates SCRAM channel binding itself.
_LIBPQ_ONLY = frozenset({"channel_binding"})


def _asyncpg_query(query: str) -> str:
    """Rewrite libpq's ``sslmode`` as asyncpg's ``ssl`` (same values),
    keeping an explicit ``ssl`` if both are given, and drop parameters
    asyncpg does not understand."""
    pairs = parse_qsl(query, keep_blank_values=True)
    has_ssl = any(key == "ssl" for key, _ in pairs)
    kept: list[tuple[str, str]] = []
    for key, value in pairs:
        if key in _LIBPQ_ONLY or (key == "sslmode" and has_ssl):
            continue
        kept.append(("ssl", value) if key == "sslmode" else (key, value))
    return urlencode(kept)


def async_url(url: str) -> str:
    """Accept a standard ``postgresql://`` URL, as libpq, psycopg and
    Alembic take it, and turn it into an asyncpg one."""
    for prefix in ("postgresql+asyncpg://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            parts = urlsplit("postgresql+asyncpg://" + url.removeprefix(prefix))
            return urlunsplit(parts._replace(query=_asyncpg_query(parts.query)))
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
