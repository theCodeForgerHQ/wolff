"""Async database access: one engine per process, asyncpg."""

from __future__ import annotations

import ssl
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

# libpq sslmode values that asyncpg takes as the same words and the same
# meaning. The verifying modes are not in this set: they are turned into an
# explicit SSLContext below, so certificate and hostname checks never depend
# on how a string is interpreted further down.
_PLAIN_SSL_MODES = frozenset({"disable", "allow", "prefer", "require"})
_VERIFYING_SSL_MODES = frozenset({"verify-ca", "verify-full"})

SslArgument = str | ssl.SSLContext


def _verifying_context(mode: str) -> ssl.SSLContext:
    """Certificate checked against the system CAs; for verify-full the
    hostname too (verify-ca checks the chain only, as in libpq)."""
    context = ssl.create_default_context()
    context.verify_mode = ssl.CERT_REQUIRED
    context.check_hostname = mode == "verify-full"
    return context


def _ssl_argument(mode: str) -> SslArgument:
    if mode in _VERIFYING_SSL_MODES:
        return _verifying_context(mode)
    if mode in _PLAIN_SSL_MODES:
        return mode
    raise ValueError(f"AI_DATABASE_URL has an unknown sslmode {mode!r}")


def asyncpg_target(url: str) -> tuple[str, SslArgument | None]:
    """Split a standard ``postgresql://`` URL (as libpq, psycopg and Alembic
    take it) into an asyncpg URL and the ``ssl`` argument for connect().

    ``sslmode`` (libpq) and ``ssl`` (asyncpg) are both read; if both are given
    they must agree. No SSL parameter gives ``None``: asyncpg's default, as
    before. An unknown value is an error, never dropped.
    """
    for prefix in ("postgresql+asyncpg://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            break
    else:
        raise ValueError("AI_DATABASE_URL must be a postgresql:// URL")
    parts = urlsplit("postgresql+asyncpg://" + url.removeprefix(prefix))
    kept: list[tuple[str, str]] = []
    modes: set[str] = set()
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key in ("ssl", "sslmode"):
            modes.add(value)
        elif key not in _LIBPQ_ONLY:
            kept.append((key, value))
    if len(modes) > 1:
        raise ValueError("AI_DATABASE_URL has conflicting ssl and sslmode values")
    ssl_argument = _ssl_argument(modes.pop()) if modes else None
    return urlunsplit(parts._replace(query=urlencode(kept))), ssl_argument


def create_engine(url: str) -> AsyncEngine:
    """Engine whose connections see ``ai`` first, then ``public``.

    The statement cache is off because the free demo connects through a
    transaction-mode pooler (Neon), where prepared statements break.
    """
    target, ssl_argument = asyncpg_target(url)
    connect_args: dict[str, object] = {
        "statement_cache_size": 0,
        "server_settings": {"search_path": "ai,public"},
    }
    if ssl_argument is not None:
        connect_args["ssl"] = ssl_argument
    return create_async_engine(target, pool_pre_ping=True, connect_args=connect_args)


def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Sessions that keep loaded values after commit."""
    return async_sessionmaker(engine, expire_on_commit=False)
