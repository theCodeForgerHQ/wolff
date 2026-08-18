"""The one way out to an LLM provider.

Both the OpenAI SDK (embeddings) and LangChain's ChatOpenAI (chat, tools,
structured output) are given an httpx client built on this transport, so
every request passes the same checks:

- a token bucket on requests per minute and on (estimated) tokens per
  minute, and a requests-per-day counter shared through Redis;
- bounded concurrency;
- two retries on 429/5xx/timeouts, honouring ``Retry-After`` (the SDKs'
  own retries are switched off so they do not multiply);
- the model allowlist, checked on the request body;
- a ``UsageGate`` called before (budget check) and after (record usage)
  each request.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import httpx

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_ATTEMPTS = 3
MAX_RETRY_AFTER_SECONDS = 30.0


class LlmUnavailable(Exception):
    """The request was refused before reaching the provider."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass(frozen=True, slots=True)
class Usage:
    model: str
    tokens_in: int
    tokens_out: int


class UsageGate(Protocol):
    async def before(self, model: str) -> None:
        """Raise (e.g. budget exceeded) to stop the request."""

    async def after(self, usage: Usage) -> None:
        """Record what the request used."""


class DailyCounter(Protocol):
    async def increment(self, key: str) -> int: ...


class MemoryDailyCounter:
    def __init__(self) -> None:
        self._counts: dict[str, int] = {}

    async def increment(self, key: str) -> int:
        self._counts[key] = self._counts.get(key, 0) + 1
        return self._counts[key]


class RedisDailyCounter:
    """Shared across instances; keys expire after two days."""

    def __init__(self, redis: Any) -> None:
        self._redis = redis

    async def increment(self, key: str) -> int:
        count = int(await self._redis.incr(key))
        if count == 1:
            await self._redis.expire(key, 2 * 86_400)
        return count


@dataclass
class TokenBucket:
    """``capacity`` units per minute, refilled continuously."""

    capacity: float
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    _level: float = field(init=False)
    _at: float = field(init=False)
    _lock: asyncio.Lock = field(init=False, default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        self._level = self.capacity
        self._at = self.clock()

    async def take(self, amount: float) -> None:
        amount = min(amount, self.capacity)
        async with self._lock:
            while True:
                now = self.clock()
                self._level = min(
                    self.capacity, self._level + (now - self._at) * self.capacity / 60
                )
                self._at = now
                if self._level >= amount:
                    self._level -= amount
                    return
                await self.sleep((amount - self._level) * 60 / self.capacity)


def _seconds_to_utc_midnight(now: datetime) -> float:
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return (tomorrow - now).total_seconds()


def _retry_after(response: httpx.Response, attempt: int) -> float:
    header = response.headers.get("retry-after")
    if header:
        try:
            return min(float(header), MAX_RETRY_AFTER_SECONDS)
        except ValueError:
            pass
    return min(2.0**attempt + random.uniform(0, 1), MAX_RETRY_AFTER_SECONDS)  # noqa: S311


def _usage(model: str, body: bytes) -> Usage:
    try:
        data = json.loads(body)
        usage = data.get("usage") or {}
        tokens_in = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        tokens_out = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    except (ValueError, AttributeError, TypeError):
        tokens_in = tokens_out = 0
    return Usage(model=model, tokens_in=tokens_in, tokens_out=tokens_out)


class RateLimitedTransport(httpx.AsyncBaseTransport):
    def __init__(
        self,
        inner: httpx.AsyncBaseTransport,
        *,
        provider: str,
        rpm: int,
        tpm: int,
        rpd: int,
        max_concurrency: int,
        allowed_models: frozenset[str],
        gate: UsageGate,
        daily: DailyCounter,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._inner = inner
        self._provider = provider
        self._rpd = rpd
        self._requests = TokenBucket(rpm, clock=clock, sleep=sleep)
        self._tokens = TokenBucket(tpm, clock=clock, sleep=sleep)
        self._slots = asyncio.Semaphore(max_concurrency)
        self._allowed = allowed_models
        self._gate = gate
        self._daily = daily
        self._sleep = sleep
        self._now = now

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = request.content
        try:
            model = str(json.loads(body).get("model", ""))
        except ValueError:
            model = ""
        if model not in self._allowed:
            raise LlmUnavailable(f"model {model!r} is not allowed")
        await self._gate.before(model)

        now = self._now()
        if await self._daily.increment(f"llm:rpd:{self._provider}:{now.date()}") > self._rpd:
            raise LlmUnavailable(
                "daily request limit reached", retry_after=_seconds_to_utc_midnight(now)
            )

        async with self._slots:
            await self._requests.take(1)
            await self._tokens.take(len(body) / 4)
            response = await self._send_with_retries(request)

        content = await response.aread()
        if response.status_code < 400:
            await self._gate.after(_usage(model, content))
        return httpx.Response(
            response.status_code, headers=response.headers, content=content, request=request
        )

    async def _send_with_retries(self, request: httpx.Request) -> httpx.Response:
        for attempt in range(MAX_ATTEMPTS):
            last = attempt == MAX_ATTEMPTS - 1
            try:
                response = await self._inner.handle_async_request(request)
            except (httpx.TimeoutException, httpx.NetworkError):
                if last:
                    raise
                await self._sleep(min(2.0**attempt, MAX_RETRY_AFTER_SECONDS))
                continue
            if response.status_code not in RETRY_STATUSES or last:
                return response
            await response.aread()
            await self._sleep(_retry_after(response, attempt))
        raise AssertionError("unreachable")

    async def aclose(self) -> None:
        await self._inner.aclose()
