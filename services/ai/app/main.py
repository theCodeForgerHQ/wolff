"""FastAPI application for the AI service."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import ingest
from app.api.deps import install_error_handlers
from app.services import Services, build_services
from app.settings import Settings, load_settings


def create_app(settings: Settings | None = None, services: Services | None = None) -> FastAPI:
    """Build the app. ``services`` is built at start-up unless given (tests)."""
    resolved = settings or (services.settings if services else load_settings())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owned = services is None
        app.state.services = services or build_services(resolved)
        try:
            yield
        finally:
            if owned:
                await app.state.services.aclose()

    app = FastAPI(title="ai", lifespan=lifespan if services is None else None)
    app.state.settings = resolved
    if services is not None:
        app.state.services = services
    install_error_handlers(app)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "ai", "version": resolved.git_sha or "dev"}

    app.include_router(ingest.router)
    return app


def get_app() -> FastAPI:
    """Factory for ``uvicorn --factory``."""
    return create_app()
