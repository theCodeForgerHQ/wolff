import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.settings import Settings, SettingsError, load_settings


async def test_healthz_reports_ok_and_version() -> None:
    app = create_app(Settings(git_sha="abc123"))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ai", "version": "abc123"}


async def test_healthz_answers_head() -> None:
    # UptimeRobot's free HTTP monitor checks with HEAD; a GET-only route
    # answers 405 and the monitor reports the service down.
    app = create_app(Settings(git_sha="abc123"))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.head("/healthz")
    assert response.status_code == 200
    assert response.content == b""


def test_settings_read_from_environment() -> None:
    settings = load_settings({"GIT_SHA": "deadbeef", "ENVIRONMENT": "production"})
    assert settings.git_sha == "deadbeef"
    assert settings.environment == "production"


def test_settings_defaults() -> None:
    settings = load_settings({})
    assert settings.environment == "development"
    assert settings.git_sha is None


def test_settings_reject_an_unknown_environment() -> None:
    with pytest.raises(SettingsError, match="ENVIRONMENT"):
        load_settings({"ENVIRONMENT": "staging-ish"})


def test_blank_values_count_as_unset() -> None:
    assert load_settings({"GIT_SHA": "  "}).git_sha is None
