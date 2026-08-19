"""Calls apps/api ``/internal/*`` as the original caller.

Each request carries a fresh ai-minted JWT (aud=api, 60 s) that forwards
the caller's user, workspace and scopes; it can narrow them, never widen.
"""

from __future__ import annotations

from collections.abc import Collection
from typing import Any

import httpx2 as httpx

from app.auth import Caller, mint_api_token

TIMEOUT_SECONDS = 15.0


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


class ApiUnavailable(Exception):
    """apps/api could not be reached; callers degrade instead of failing."""


class ApiClient:
    def __init__(self, base_url: str, secret: str | None, http: httpx.AsyncClient | None = None):
        self._base = base_url.rstrip("/")
        self._secret = secret
        self._http = http or httpx.AsyncClient(timeout=TIMEOUT_SECONDS)

    async def post(
        self, caller: Caller, path: str, body: dict[str, Any], scopes: Collection[str]
    ) -> dict[str, Any]:
        if not self._secret:
            raise ApiUnavailable("SVC_JWT_SECRET_AI is not set")
        token = mint_api_token(caller, secret=self._secret, scopes=scopes)
        try:
            response = await self._http.post(
                f"{self._base}{path}", json=body, headers={"authorization": f"Bearer {token}"}
            )
        except httpx.HTTPError as exc:
            raise ApiUnavailable(str(exc)) from exc
        if response.status_code >= 500:
            raise ApiUnavailable(f"{path} answered {response.status_code}")
        payload: dict[str, Any] = response.json()
        if response.status_code >= 400 or not payload.get("success"):
            error = payload.get("error") or {}
            raise ApiError(response.status_code, str(error.get("code")), str(error.get("message")))
        data: dict[str, Any] = payload["data"]
        return data

    async def aclose(self) -> None:
        await self._http.aclose()
