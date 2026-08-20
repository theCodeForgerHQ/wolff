from __future__ import annotations

from fastapi import FastAPI

from app.observability import REDACTED, init_observability, scrub_event
from tests.conftest import make_settings


def test_nothing_starts_without_configuration() -> None:
    assert init_observability(FastAPI(), make_settings()) == {"sentry": False, "otel": False}


def test_tracing_instruments_the_app_when_an_endpoint_is_set() -> None:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    app = FastAPI()
    started = init_observability(
        app, make_settings(otel_exporter_otlp_endpoint="http://127.0.0.1:4318")
    )
    try:
        assert started["otel"]
        assert getattr(app, "_is_instrumented_by_opentelemetry", False)
    finally:
        FastAPIInstrumentor.uninstrument_app(app)


def test_events_are_scrubbed() -> None:
    event = {
        "request": {
            "headers": {"Authorization": "Bearer abc", "X-Trace": "t1"},
            "data": {"message": "mail priya@example.com key qc_sk_abcdef123", "gstin": "29AB"},
        },
        "extra": {"phone": "+91 99999", "workspace_id": "ws-1"},
    }
    out = scrub_event(event)
    assert out["request"]["headers"] == {"Authorization": REDACTED, "X-Trace": "t1"}
    assert out["request"]["data"]["message"] == f"mail {REDACTED} key {REDACTED}"
    assert out["request"]["data"]["gstin"] == REDACTED
    assert out["extra"] == {"phone": REDACTED, "workspace_id": "ws-1"}
