"""API-key authentication for the MCP server.

The bearer is an API key looked up by its SHA-256 hash in public.api_keys,
the same unique-hash lookup as packages/core (a unique-hash lookup leaks
nothing useful through timing). Only secret keys (`qc_sk_` or
`<slug>_sk_`) that are not revoked or expired and hold `ai:use` pass. The
workspace comes from the key row only; it is carried in the AccessToken's
claims and never read from tool arguments.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from mcp.server.auth.provider import AccessToken
from sqlalchemy import Text, cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth import Caller
from app.db.public_models import ApiKey

LEGACY_PREFIX = "qc_sk_"
REQUIRED_SCOPE = "ai:use"


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


class ApiKeyTokenVerifier:
    def __init__(self, sessions: async_sessionmaker[AsyncSession], product_slug: str) -> None:
        self._sessions = sessions
        self._prefixes = (LEGACY_PREFIX, f"{product_slug}_sk_")

    def _looks_like_key(self, raw: str) -> bool:
        return any(raw.startswith(p) and len(raw) > len(p) for p in self._prefixes)

    async def verify_token(self, token: str) -> AccessToken | None:
        if not self._looks_like_key(token):
            return None
        now = datetime.now(UTC).replace(tzinfo=None)  # Prisma stores naive UTC
        async with self._sessions() as session:
            key = await session.scalar(
                select(ApiKey).where(
                    ApiKey.key_hash == hash_key(token),
                    # Prisma enum column: compare as text.
                    cast(ApiKey.kind, Text) == "secret",
                    ApiKey.revoked_at.is_(None),
                    or_(ApiKey.expires_at.is_(None), ApiKey.expires_at > now),
                )
            )
        if key is None or REQUIRED_SCOPE not in key.scopes:
            return None
        return AccessToken(
            token=token,
            client_id=key.id,
            scopes=list(key.scopes),
            claims={"workspace_id": key.workspace_id},
        )


def caller_from_token(token: AccessToken) -> Caller | None:
    workspace = (token.claims or {}).get("workspace_id")
    if not isinstance(workspace, str) or not workspace:
        return None
    return Caller(
        issuer="api_key",
        workspace_id=workspace,
        user_id=None,
        scopes=frozenset(token.scopes),
        key_id=token.client_id,
    )
