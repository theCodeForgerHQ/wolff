"""Settings for the AI service, read from the environment once at start."""

from __future__ import annotations

import os
from collections.abc import Mapping
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.llm.providers import (
    ProviderError,
    ProviderProfile,
    resolve_fallback,
    resolve_provider,
)


class SettingsError(ValueError):
    """A variable is present but malformed; the service must not start."""


class Settings(BaseModel):
    """Everything the service reads from the environment."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    environment: Literal["development", "test", "production"] = "development"
    git_sha: str | None = None
    #: SQLAlchemy URL of the ai_service login.
    database_url: str | None = None
    redis_url: str | None = None
    #: One secret per service that may call this one, and ours for apps/api.
    svc_jwt_secret_web: str | None = None
    svc_jwt_secret_worker: str | None = None
    svc_jwt_secret_ai: str | None = None
    #: apps/api origin, for /internal/* calls.
    api_url: str = "http://localhost:4000"
    #: This service's public URL (MCP resource server URL).
    public_url: str = "http://localhost:8000"
    daily_budget_usd: Decimal = Field(default=Decimal("0.50"), ge=0)
    max_tokens: int = Field(default=1024, gt=0, le=16_384)
    sentry_dsn: str | None = None
    sentry_traces_sample_rate: float = Field(default=0.1, ge=0, le=1)
    otel_exporter_otlp_endpoint: str | None = None
    #: The product's slug (packages/core/src/brand.ts): API key prefixes
    #: `<slug>_sk_` and the MCP server's name.
    #: Where nightly reports are written (S3 arrives with Phase 6's infra).
    reports_dir: str = "var/reports"
    product_slug: str = Field(default="wolff", pattern=r"^[a-z][a-z0-9-]{1,30}$")
    provider: ProviderProfile = Field(default_factory=lambda: resolve_provider({}))
    #: Chat-only fallback provider (LLM_FALLBACK), or None.
    fallback: ProviderProfile | None = None


_ENV_NAMES: dict[str, str] = {
    "environment": "ENVIRONMENT",
    "git_sha": "GIT_SHA",
    "database_url": "AI_DATABASE_URL",
    "redis_url": "REDIS_URL",
    "svc_jwt_secret_web": "SVC_JWT_SECRET_WEB",
    "svc_jwt_secret_worker": "SVC_JWT_SECRET_WORKER",
    "svc_jwt_secret_ai": "SVC_JWT_SECRET_AI",
    "api_url": "API_INTERNAL_URL",
    "public_url": "AI_PUBLIC_URL",
    "daily_budget_usd": "AI_DAILY_BUDGET_USD",
    "max_tokens": "AI_MAX_TOKENS",
    "sentry_dsn": "SENTRY_DSN",
    "sentry_traces_sample_rate": "SENTRY_TRACES_SAMPLE_RATE",
    "otel_exporter_otlp_endpoint": "OTEL_EXPORTER_OTLP_ENDPOINT",
    "product_slug": "PRODUCT_SLUG",
    "reports_dir": "AI_REPORTS_DIR",
}


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build settings from ``env`` (default: the process environment).

    Blank values count as unset, so an empty line in a .env file falls back
    to the default instead of failing validation.
    """
    source = os.environ if env is None else env
    values: dict[str, object] = {
        field: raw.strip()
        for field, name in _ENV_NAMES.items()
        if (raw := source.get(name)) is not None and raw.strip()
    }
    try:
        values["provider"] = resolve_provider(source)
        values["fallback"] = resolve_fallback(source)
    except ProviderError as exc:
        raise SettingsError(str(exc)) from None
    try:
        return Settings.model_validate(values)
    except ValidationError as exc:
        problems = [
            f"{_ENV_NAMES.get(str(error['loc'][0]), error['loc'][0])}: {error['msg']}"
            for error in exc.errors()
        ]
        raise SettingsError("; ".join(problems)) from None
