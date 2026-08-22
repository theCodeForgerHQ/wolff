import pytest

from app.db.session import async_url
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
def test_async_url_selects_asyncpg(given: str, expected: str) -> None:
    assert async_url(given) == expected


def test_async_url_rejects_other_databases() -> None:
    with pytest.raises(ValueError, match="postgresql"):
        async_url("mysql://u@h/d")


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        # libpq's sslmode is what Neon and Alembic (psycopg) use; asyncpg
        # spells it ssl and rejects sslmode.
        (
            "postgresql://u@h/d?sslmode=require",
            "postgresql+asyncpg://u@h/d?ssl=require",
        ),
        (
            "postgresql://u@h/d?sslmode=verify-full&application_name=ai",
            "postgresql+asyncpg://u@h/d?ssl=verify-full&application_name=ai",
        ),
        # Neon's copied URL also carries channel_binding, which asyncpg
        # does not accept either; it negotiates SCRAM by itself.
        (
            "postgresql://u@h/d?sslmode=require&channel_binding=require",
            "postgresql+asyncpg://u@h/d?ssl=require",
        ),
        ("postgresql://u@h/d?ssl=require", "postgresql+asyncpg://u@h/d?ssl=require"),
    ],
)
def test_async_url_translates_libpq_ssl_parameters(given: str, expected: str) -> None:
    assert async_url(given) == expected


def test_async_url_keeps_an_explicit_ssl_over_sslmode() -> None:
    assert async_url("postgresql://u@h/d?ssl=disable&sslmode=require") == (
        "postgresql+asyncpg://u@h/d?ssl=disable"
    )
