"""FastAPI application for the AI service."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.types import Receive, Scope, Send

from app.api import chat, drafts, ingest, search
from app.api.deps import install_error_handlers
from app.mcp.server import build_mcp_server, mcp_http_app
from app.services import Services, build_services
from app.settings import Settings, load_settings


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    """Build the app. ``services`` is built at start-up unless given (tests)."""
    resolved = settings or (services.settings if services else load_settings())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owned = services is None
        svc = services or build_services(resolved)
        app.state.services = svc
        server = build_mcp_server(svc)
        app.state.mcp = mcp_http_app(server, resolved.public_url)
        try:
            async with server.session_manager.run():
                yield
        finally:
            if owned:
                await svc.aclose()

    app = FastAPI(title="ai", lifespan=lifespan)
    app.state.settings = resolved
    if services is not None:
        app.state.services = services

    async def mcp_endpoint(scope: Scope, receive: Receive, send: Send) -> None:
        # Built in the lifespan, when the services exist.
        await app.state.mcp(scope, receive, send)

    app.mount("/mcp", mcp_endpoint)
    install_error_handlers(app)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "ai", "version": resolved.git_sha or "dev"}

    app.include_router(ingest.router)
    app.include_router(search.router)
    app.include_router(chat.router)
    app.include_router(drafts.router)
    return app


def get_app() -> FastAPI:
    """Factory for ``uvicorn --factory``."""
    return create_app()
