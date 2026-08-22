import ssl
from typing import Any

import pytest

from app.db import session
from app.db.session import asyncpg_target
from app.settings import SettingsError, load_settings


def test_database_url_is_read_from_ai_database_url() -> None:
    assert load_settings({"AI_DATABASE_URL": "postgresql://u@h/d"}).database_url == (
        "postgresql://u@h/d"
    )


def test_settings_error_names_every_bad_variable() -> None:
    with pytest.raises(SettingsError, match="ENVIRONMENT"):
        load_settings({"ENVIRONMENT": "nope"})


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("postgresql://u:p@h:5432/d", "postgresql+asyncpg://u:p@h:5432/d"),
        ("postgres://u@h/d", "postgresql+asyncpg://u@h/d"),
        ("postgresql+asyncpg://u@h/d", "postgresql+asyncpg://u@h/d"),
    ],
)
def test_asyncpg_target_selects_asyncpg(given: str, expected: str) -> None:
    # No SSL parameter: no ssl argument, asyncpg's default as before.
    assert asyncpg_target(given) == (expected, None)


def test_asyncpg_target_rejects_other_databases() -> None:
    with pytest.raises(ValueError, match="postgresql"):
        asyncpg_target("mysql://u@h/d")


@pytest.mark.parametrize("mode", ["disable", "allow", "prefer", "require"])
@pytest.mark.parametrize("key", ["sslmode", "ssl"])
def test_non_verifying_modes_pass_through_unchanged(key: str, mode: str) -> None:
    # libpq's sslmode and asyncpg's ssl use the same words for these.
    url, ssl_argument = asyncpg_target(f"postgresql://u@h/d?{key}={mode}&application_name=ai")
    assert url == "postgresql+asyncpg://u@h/d?application_name=ai"
    assert ssl_argument == mode


def test_require_stays_encrypted() -> None:
    assert asyncpg_target("postgresql://u@h/d?sslmode=require")[1] == "require"


def test_verify_full_checks_the_certificate_and_the_hostname() -> None:
    _, ssl_argument = asyncpg_target("postgresql://u@h/d?sslmode=verify-full")
    assert isinstance(ssl_argument, ssl.SSLContext)
    assert ssl_argument.verify_mode == ssl.CERT_REQUIRED
    assert ssl_argument.check_hostname is True


def test_verify_ca_checks_the_certificate_but_not_the_hostname() -> None:
    _, ssl_argument = asyncpg_target("postgresql://u@h/d?sslmode=verify-ca")
    assert isinstance(ssl_argument, ssl.SSLContext)
    assert ssl_argument.verify_mode == ssl.CERT_REQUIRED
    assert ssl_argument.check_hostname is False


@pytest.mark.parametrize("query", ["sslmode=requir", "sslmode=", "ssl=true", "sslmode=VERIFY-FULL"])
def test_an_unknown_ssl_mode_is_an_error(query: str) -> None:
    with pytest.raises(ValueError, match="sslmode"):
        asyncpg_target(f"postgresql://u@h/d?{query}")


def test_conflicting_ssl_and_sslmode_is_an_error() -> None:
    # Picking either would silently drop the other; disable vs require
    # is exactly the downgrade this must not choose.
    with pytest.raises(ValueError, match="conflicting"):
        asyncpg_target("postgresql://u@h/d?ssl=disable&sslmode=require")


def test_neon_url_drops_channel_binding_and_keeps_require() -> None:
    assert asyncpg_target("postgresql://u@h/d?sslmode=require&channel_binding=require") == (
        "postgresql+asyncpg://u@h/d",
        "require",
    )


def test_the_engine_connects_with_the_verifying_context(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake_engine(url: str, **kwargs: Any) -> object:
        seen.update(kwargs, url=url)
        return object()

    monkeypatch.setattr(session, "create_async_engine", fake_engine)
    session.create_engine("postgresql://u@h/d?sslmode=verify-full")
    assert seen["url"] == "postgresql+asyncpg://u@h/d"
    context = seen["connect_args"]["ssl"]
    assert isinstance(context, ssl.SSLContext)
    assert context.check_hostname is True
    assert context.verify_mode == ssl.CERT_REQUIRED


def test_the_engine_passes_no_ssl_argument_without_one(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    monkeypatch.setattr(session, "create_async_engine", lambda url, **kw: seen.update(kw))
    session.create_engine("postgresql://u@h/d")
    assert "ssl" not in seen["connect_args"]
