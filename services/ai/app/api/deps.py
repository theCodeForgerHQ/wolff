"""Request dependencies: services, the authenticated caller, errors."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.auth import AuthError, Caller, InsufficientScope
from app.budget import BudgetExceeded
from app.llm.transport import LlmUnavailable
from app.services import Services

_BEARER = "bearer "


def services(request: Request) -> Services:
    found: Services = request.app.state.services
    return found


def require_service(issuers: frozenset[str], scope: str) -> Callable[[Request], Awaitable[Caller]]:
    """A dependency that authenticates a service JWT from one of ``issuers``
    and checks ``scope``. The workspace comes only from the token."""

    async def dependency(request: Request) -> Caller:
        header = request.headers.get("authorization", "")
        if not header.lower().startswith(_BEARER):
            raise AuthError("missing bearer token")
        caller = await services(request).verifier.verify(header[len(_BEARER) :].strip())
        if caller.issuer not in issuers:
            raise AuthError("issuer not accepted here")
        caller.require(scope)
        return caller

    return dependency


def error(
    status: int, code: str, message: str, headers: dict[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(
        {"success": False, "error": {"code": code, "message": message}},
        status_code=status,
        headers=headers,
    )


def install_error_handlers(app: FastAPI) -> None:
    async def auth(_: Request, exc: Exception) -> JSONResponse:
        if isinstance(exc, InsufficientScope):
            return error(403, "insufficient_scope", str(exc))
        return error(401, "unauthorized", "A valid service token is required")

    async def budget(_: Request, exc: Exception) -> JSONResponse:
        retry = getattr(exc, "retry_after", None)
        headers = {"Retry-After": str(int(retry))} if retry else None
        if isinstance(exc, BudgetExceeded):
            return error(429, "ai_budget_exceeded", str(exc), headers)
        return error(503, "ai_unavailable", str(exc), headers)

    app.add_exception_handler(AuthError, auth)
    app.add_exception_handler(LlmUnavailable, budget)


def ok(data: Any) -> dict[str, Any]:
    return {"success": True, "data": data}
