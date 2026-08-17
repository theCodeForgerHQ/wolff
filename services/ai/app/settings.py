"""Settings for the AI service."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError


class SettingsError(ValueError):
    """Raised when settings validation fails."""


class Settings(BaseModel):
    """Application settings."""

    model_config = ConfigDict(frozen=True)

    environment: Literal["development", "test", "production"] = "development"
    git_sha: str | None = None


_FIELD_TO_ENV: dict[str, str] = {
    "environment": "ENVIRONMENT",
    "git_sha": "GIT_SHA",
}


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Load settings from environment variables.

    Args:
        env: Mapping of environment variables. Defaults to os.environ.

    Returns:
        Validated Settings instance.

    Raises:
        SettingsError: If validation fails, with message naming the env var.
    """
    if env is None:
        env = os.environ

    values: dict[str, str | None] = {}
    for field, env_var in _FIELD_TO_ENV.items():
        raw = env.get(env_var)
        if raw is not None:
            stripped = raw.strip()
            if stripped:
                values[field] = stripped

    try:
        return Settings(**values)
    except ValidationError as exc:
        for error in exc.errors():
            loc = error["loc"]
            field = str(loc[0]) if loc else "unknown"
            env_var = _FIELD_TO_ENV.get(field, field.upper())
            raise SettingsError(f"{env_var}: {error['msg']}") from None
        raise SettingsError("Unknown validation error") from None
