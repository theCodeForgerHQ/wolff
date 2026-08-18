"""Service-to-service authentication.

Inbound: the web app (chat proxy) and the worker (indexing) call this
service with HS256 JWTs, ``aud=ai``, valid 60 seconds. Each issuer signs
with its own secret and names itself in the ``kid`` header, so a leaked
worker secret cannot speak as the web app.

Outbound: when this service calls ``apps/api`` ``/internal/*`` it mints an
``aud=api`` token that forwards the original caller's user, workspace and
scopes. It can narrow the scopes, never widen them.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

import jwt

TOKEN_TTL_SECONDS = 60
#: How long a jti is remembered; longer than any token can live.
REPLAY_TTL_SECONDS = 120


class AuthError(Exception):
    """The credential is missing, invalid, replayed, or lacks a scope."""


class InsufficientScope(AuthError):
    """Authenticated, but without the scope this action needs (HTTP 403)."""


@dataclass(frozen=True, slots=True)
class Caller:
    """Who is calling, as proven by a service JWT or an API key."""

    issuer: str
    workspace_id: str
    user_id: str | None
    scopes: frozenset[str]
    #: The API key's id, when the caller authenticated with one (MCP).
    key_id: str | None = None

    def require(self, scope: str) -> None:
        """Raise unless the caller holds ``scope``."""
        if scope not in self.scopes:
            raise InsufficientScope(f"missing scope {scope}")


class ReplayCache(Protocol):
    """Remembers token ids; ``claim`` is False when the id was seen before."""

    async def claim(self, jti: str, ttl_seconds: int) -> bool: ...


class MemoryReplayCache:
    """Per-process cache: enough for one instance and for tests."""

    def __init__(self) -> None:
        self._seen: dict[str, float] = {}

    async def claim(self, jti: str, ttl_seconds: int) -> bool:
        now = time.monotonic()
        self._seen = {key: until for key, until in self._seen.items() if until > now}
        if jti in self._seen:
            return False
        self._seen[jti] = now + ttl_seconds
        return True


class RedisReplayCache:
    """Shared across instances, so a token replayed elsewhere is refused too."""

    def __init__(self, redis: Any) -> None:
        self._redis = redis

    async def claim(self, jti: str, ttl_seconds: int) -> bool:
        return bool(await self._redis.set(f"ai:jti:{jti}", "1", ex=ttl_seconds, nx=True))


def _string_list(value: object) -> list[str] | None:
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return list(value)
    return None


class ServiceJwtVerifier:
    """Verifies inbound service JWTs for one audience."""

    def __init__(
        self,
        *,
        secrets: Mapping[str, str | None],
        issuers: Iterable[str],
        audience: str,
        replay_cache: ReplayCache,
    ) -> None:
        self._secrets = dict(secrets)
        self._issuers = frozenset(issuers)
        self._audience = audience
        self._replay = replay_cache

    async def verify(self, token: str) -> Caller:
        """Return the caller, or raise AuthError. Every failure looks the same."""
        try:
            claims = self._decode(token)
        except (jwt.PyJWTError, ValueError) as exc:
            raise AuthError("invalid service token") from exc

        if not await self._replay.claim(str(claims["jti"]), REPLAY_TTL_SECONDS):
            raise AuthError("invalid service token")
        sub = claims.get("sub")
        return Caller(
            issuer=str(claims["iss"]),
            workspace_id=str(claims["workspaceId"]),
            user_id=sub if isinstance(sub, str) and sub else None,
            scopes=frozenset(claims["scopes"]),
        )

    def _decode(self, token: str) -> dict[str, Any]:
        # The key id only selects which secret to try; the signature decides.
        kid = jwt.get_unverified_header(token).get("kid")
        if not isinstance(kid, str) or kid not in self._issuers:
            raise ValueError("issuer not accepted")
        secret = self._secrets.get(kid)
        if not secret:
            raise ValueError("issuer has no secret")

        claims: dict[str, Any] = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=self._audience,
            issuer=kid,
            options={"require": ["exp", "iat", "jti", "iss", "aud"]},
        )
        exp, iat, jti = claims["exp"], claims["iat"], claims["jti"]
        if not (isinstance(exp, int) and isinstance(iat, int) and isinstance(jti, str) and jti):
            raise ValueError("malformed registered claims")
        if exp - iat > TOKEN_TTL_SECONDS or time.time() - iat > TOKEN_TTL_SECONDS:
            raise ValueError("token lives too long")
        workspace = claims.get("workspaceId")
        if not isinstance(workspace, str) or not workspace:
            raise ValueError("no workspace")
        if _string_list(claims.get("scopes")) is None:
            raise ValueError("scopes must be a list of strings")
        return claims


def mint_api_token(caller: Caller, *, secret: str, scopes: Collection[str] | None = None) -> str:
    """An ``aud=api`` token acting as ``caller``.

    ``scopes`` narrows what is forwarded; asking for a scope the caller does
    not hold raises instead of widening.
    """
    forwarded = set(caller.scopes) if scopes is None else set(scopes)
    extra = forwarded - caller.scopes
    if extra:
        raise AuthError(f"cannot forward scopes the caller lacks: {', '.join(sorted(extra))}")
    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": "ai",
        "aud": "api",
        "iat": now,
        "exp": now + TOKEN_TTL_SECONDS,
        "jti": str(uuid.uuid4()),
        "workspaceId": caller.workspace_id,
        "scopes": sorted(forwarded),
    }
    if caller.user_id:
        payload["sub"] = caller.user_id
    return jwt.encode(payload, secret, algorithm="HS256", headers={"kid": "ai"})
