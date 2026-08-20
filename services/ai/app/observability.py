"""Errors and traces.

Sentry starts only with SENTRY_DSN; OpenTelemetry tracing of the FastAPI
app (OTLP over HTTP) only with OTEL_EXPORTER_OTLP_ENDPOINT. Without them
nothing is sent anywhere. Events are scrubbed of credentials and personal
data before they leave, with the same fields the Node services redact.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import FastAPI

from app.settings import Settings

REDACTED = "[redacted]"
_SENSITIVE_KEYS = re.compile(
    r"authorization|cookie|token|secret|password|api[_-]?key|email|phone|pan|gstin", re.I
)
_KEY_VALUE = re.compile(r"\b(qc|[a-z]+)_sk_[A-Za-z0-9]+")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: REDACTED if _SENSITIVE_KEYS.search(str(k)) else _scrub(v) for k, v in value.items()
        }
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    if isinstance(value, str):
        return _EMAIL.sub(REDACTED, _KEY_VALUE.sub(REDACTED, value))
    return value


def scrub_event(event: dict[str, Any], _hint: dict[str, Any] | None = None) -> dict[str, Any]:
    """Sentry before_send: redact headers, credentials, emails, phones."""
    scrubbed: dict[str, Any] = _scrub(event)
    return scrubbed


def init_observability(app: FastAPI, settings: Settings) -> dict[str, bool]:
    started = {"sentry": False, "otel": False}
    if settings.sentry_dsn:
        import sentry_sdk

        sentry_sdk.init(
            dsn=settings.sentry_dsn,
            environment=settings.environment,
            release=settings.git_sha,
            traces_sample_rate=settings.sentry_traces_sample_rate,
            send_default_pii=False,
            before_send=scrub_event,  # type: ignore[arg-type]
        )
        started["sentry"] = True
    if settings.otel_exporter_otlp_endpoint:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(resource=Resource.create({"service.name": "ai"}))
        endpoint = settings.otel_exporter_otlp_endpoint.rstrip("/") + "/v1/traces"
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
        app.state.tracer_provider = provider
        FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
        started["otel"] = True
    return started
