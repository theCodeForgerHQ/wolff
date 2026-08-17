"""Settings for the AI service, read from the environment once at start."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError


class SettingsError(ValueError):
    """A variable is present but malformed; the service must not start."""


class Settings(BaseModel):
    """Everything the service reads from the environment."""

    model_config = ConfigDict(frozen=True)

    environment: Literal["development", "test", "production"] = "development"
    git_sha: str | None = None
    #: SQLAlchemy URL of the ai_service login.
    database_url: str | None = None


_ENV_NAMES: dict[str, str] = {
    "environment": "ENVIRONMENT",
    "git_sha": "GIT_SHA",
    "database_url": "AI_DATABASE_URL",
}


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build settings from ``env`` (default: the process environment).

    Blank values count as unset, so an empty line in a .env file falls back
    to the default instead of failing validation.
    """
    source = os.environ if env is None else env
    values = {
        field: raw.strip()
        for field, name in _ENV_NAMES.items()
        if (raw := source.get(name)) is not None and raw.strip()
    }
    try:
        return Settings.model_validate(values)
    except ValidationError as exc:
        problems = [
            f"{_ENV_NAMES.get(str(error['loc'][0]), error['loc'][0])}: {error['msg']}"
            for error in exc.errors()
        ]
        raise SettingsError("; ".join(problems)) from None
