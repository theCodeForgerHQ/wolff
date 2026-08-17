"""FastAPI application for the AI service."""

from __future__ import annotations

from fastapi import FastAPI

from app.settings import Settings, load_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the FastAPI application.

    Args:
        settings: Application settings. If None, loads from environment.

    Returns:
        Configured FastAPI application.
    """
    if settings is None:
        settings = load_settings()

    app = FastAPI(title="ai")
    app.state.settings = settings

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        """Health check endpoint."""
        version = settings.git_sha or "dev"
        return {"status": "ok", "service": "ai", "version": version}

    return app


def get_app() -> FastAPI:
    """Factory function for uvicorn --factory."""
    return create_app()
