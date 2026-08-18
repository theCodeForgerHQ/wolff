"""Service JWTs: inbound aud=ai from web/worker, outbound
aud=api minted by ai with the caller's identity and no wider scopes."""

from __future__ import annotations

import time
from typing import Any

import jwt
import pytest

from app.auth import (
    AuthError,
    Caller,
    MemoryReplayCache,
    ServiceJwtVerifier,
    mint_api_token,
)

WEB = "web-" + "0" * 60
WORKER = "worker-" + "1" * 60
AI = "ai-" + "2" * 60


def token(
    *,
    secret: str = WEB,
    kid: str | None = "web",
    iss: str = "web",
    aud: str = "ai",
    ttl: int = 60,
    iat_offset: int = 0,
    claims: dict[str, Any] | None = None,
    drop: tuple[str, ...] = (),
    alg: str = "HS256",
) -> str:
    now = int(time.time()) + iat_offset
    payload: dict[str, Any] = {
        "iss": iss,
        "aud": aud,
        "iat": now,
        "exp": now + ttl,
        "jti": f"jti-{time.monotonic_ns()}",
        "sub": "user-1",
        "workspaceId": "ws-a",
        "scopes": ["ai:use", "quotes:write"],
    }
    payload.update(claims or {})
    for key in drop:
        payload.pop(key, None)
    headers = {"kid": kid} if kid is not None else {}
    return jwt.encode(payload, secret, algorithm=alg, headers=headers)


def verifier(issuers: tuple[str, ...] = ("web", "worker")) -> ServiceJwtVerifier:
    return ServiceJwtVerifier(
        secrets={"web": WEB, "worker": WORKER},
        issuers=issuers,
        audience="ai",
        replay_cache=MemoryReplayCache(),
    )


async def test_accepts_a_valid_web_token() -> None:
    caller = await verifier().verify(token())
    assert caller == Caller(
        issuer="web",
        workspace_id="ws-a",
        user_id="user-1",
        scopes=frozenset({"ai:use", "quotes:write"}),
    )


async def test_accepts_a_worker_token_signed_with_the_worker_secret() -> None:
    caller = await verifier().verify(token(secret=WORKER, kid="worker", iss="worker"))
    assert caller.issuer == "worker"


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(dict(secret=WORKER), id="web kid signed with the worker secret"),
        pytest.param(dict(kid="worker", iss="web"), id="kid and iss disagree"),
        pytest.param(dict(kid=None), id="no kid"),
        pytest.param(dict(kid="lambda", iss="lambda"), id="issuer not accepted here"),
        pytest.param(dict(aud="api"), id="token meant for api"),
        pytest.param(dict(ttl=-1), id="expired"),
        pytest.param(dict(ttl=3600), id="lifetime above 60 s"),
        pytest.param(dict(iat_offset=-120, ttl=200), id="issued too long ago"),
        pytest.param(dict(drop=("jti",)), id="no jti"),
        pytest.param(dict(drop=("exp",)), id="no exp"),
        pytest.param(dict(drop=("iat",)), id="no iat"),
        pytest.param(dict(drop=("workspaceId",)), id="no workspace"),
        pytest.param(dict(claims={"workspaceId": ""}), id="empty workspace"),
        pytest.param(dict(claims={"workspaceId": 7}), id="workspace not a string"),
        pytest.param(dict(claims={"scopes": "ai:use"}), id="scopes not a list"),
        pytest.param(dict(claims={"scopes": ["ai:use", 1]}), id="scope not a string"),
        pytest.param(dict(alg="HS384"), id="other algorithm"),
    ],
)
async def test_rejects(bad: dict[str, Any]) -> None:
    with pytest.raises(AuthError):
        await verifier().verify(token(**bad))


async def test_rejects_garbage_and_unsigned_tokens() -> None:
    unsigned = jwt.encode({"iss": "web"}, key=None, algorithm="none", headers={"kid": "web"})
    for value in ["", "not-a-jwt", "a.b.c", unsigned]:
        with pytest.raises(AuthError):
            await verifier().verify(value)


async def test_rejects_an_issuer_without_a_configured_secret() -> None:
    v = ServiceJwtVerifier(
        secrets={"web": WEB},
        issuers=("web", "worker"),
        audience="ai",
        replay_cache=MemoryReplayCache(),
    )
    with pytest.raises(AuthError):
        await v.verify(token(secret=WORKER, kid="worker", iss="worker"))


async def test_a_token_is_accepted_once() -> None:
    v = verifier()
    value = token()
    await v.verify(value)
    with pytest.raises(AuthError):
        await v.verify(value)


async def test_minted_api_token_forwards_the_caller() -> None:
    caller = Caller(
        issuer="web", workspace_id="ws-a", user_id="user-1", scopes=frozenset({"quotes:write"})
    )
    value = mint_api_token(caller, secret=AI)
    header = jwt.get_unverified_header(value)
    claims = jwt.decode(value, AI, algorithms=["HS256"], audience="api", issuer="ai")
    assert header["kid"] == "ai"
    assert claims["workspaceId"] == "ws-a"
    assert claims["sub"] == "user-1"
    assert claims["scopes"] == ["quotes:write"]
    assert claims["exp"] - claims["iat"] == 60
    assert isinstance(claims["jti"], str) and claims["jti"]


async def test_minting_can_narrow_but_never_widen_scopes() -> None:
    caller = Caller(
        issuer="web",
        workspace_id="ws-a",
        user_id=None,
        scopes=frozenset({"quotes:write", "ai:use"}),
    )
    narrowed = jwt.decode(
        mint_api_token(caller, secret=AI, scopes={"quotes:write"}),
        AI,
        algorithms=["HS256"],
        audience="api",
    )
    assert narrowed["scopes"] == ["quotes:write"]
    assert "sub" not in narrowed
    with pytest.raises(AuthError, match="invoices:write"):
        mint_api_token(caller, secret=AI, scopes={"quotes:write", "invoices:write"})


def test_caller_scope_check() -> None:
    caller = Caller(issuer="web", workspace_id="w", user_id=None, scopes=frozenset({"ai:use"}))
    caller.require("ai:use")
    with pytest.raises(AuthError, match="quotes:write"):
        caller.require("quotes:write")
