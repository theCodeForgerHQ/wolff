from __future__ import annotations

from datetime import UTC, datetime

import httpx2 as httpx
import pytest

from app.llm.transport import (
    LlmUnavailable,
    MemoryDailyCounter,
    RateLimitedTransport,
    TokenBucket,
    Usage,
)


class Gate:
    def __init__(self, refuse: bool = False) -> None:
        self.refuse = refuse
        self.used: list[Usage] = []
        self.reserved: list[tuple[int, int]] = []
        self.released = 0

    async def reserve(self, model: str, tokens_in: int, max_tokens_out: int) -> object:
        if self.refuse:
            raise LlmUnavailable("budget")
        self.reserved.append((tokens_in, max_tokens_out))
        return len(self.reserved)

    async def settle(self, reservation: object, usage: Usage | None) -> None:
        if usage is None:
            self.released += 1
        else:
            self.used.append(usage)


class Sleeps:
    def __init__(self) -> None:
        self.calls: list[float] = []
        self.t = 0.0

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)
        self.t += seconds

    def clock(self) -> float:
        return self.t


OK = {"usage": {"prompt_tokens": 10, "completion_tokens": 5}, "choices": []}


def make(
    responses: list[httpx.Response | Exception],
    *,
    gate: Gate | None = None,
    rpm: int = 1000,
    rpd: int = 1000,
    sleeps: Sleeps | None = None,
) -> tuple[RateLimitedTransport, list[httpx.Request], Gate, Sleeps]:
    seen: list[httpx.Request] = []
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    g = gate or Gate()
    s = sleeps or Sleeps()
    t = RateLimitedTransport(
        httpx.MockTransport(handler),
        provider="p",
        rpm=rpm,
        tpm=10_000_000,
        rpd=rpd,
        max_concurrency=2,
        allowed_models=frozenset({"m"}),
        gate=g,
        daily=MemoryDailyCounter(),
        sleep=s,
        clock=s.clock,
        now=lambda: datetime(2026, 10, 3, 23, 0, tzinfo=UTC),
    )
    return t, seen, g, s


async def post(t: RateLimitedTransport, model: str = "m") -> httpx.Response:
    async with httpx.AsyncClient(transport=t, base_url="http://x") as client:
        return await client.post("/chat/completions", json={"model": model})


async def test_passes_through_and_records_usage() -> None:
    t, seen, gate, _ = make([httpx.Response(200, json=OK)])
    assert (await post(t)).status_code == 200
    assert len(seen) == 1
    assert gate.used == [Usage(model="m", tokens_in=10, tokens_out=5)]


async def test_retries_429_twice_honouring_retry_after() -> None:
    t, seen, gate, sleeps = make(
        [
            httpx.Response(429, headers={"retry-after": "7"}),
            httpx.Response(503),
            httpx.Response(200, json=OK),
        ]
    )
    assert (await post(t)).status_code == 200
    assert len(seen) == 3
    assert sleeps.calls[0] == 7
    assert len(gate.used) == 1


async def test_gives_up_after_three_attempts_and_returns_the_error() -> None:
    t, seen, gate, _ = make([httpx.Response(429)] * 3)
    assert (await post(t)).status_code == 429
    assert len(seen) == 3
    assert gate.used == []


async def test_does_not_retry_a_400() -> None:
    t, seen, _, _ = make([httpx.Response(400)])
    assert (await post(t)).status_code == 400
    assert len(seen) == 1


async def test_retries_timeouts_then_raises() -> None:
    t, seen, _, _ = make([httpx.ReadTimeout("x")] * 3)
    with pytest.raises(httpx.ReadTimeout):
        await post(t)
    assert len(seen) == 3


async def test_refuses_a_model_outside_the_allowlist_without_sending() -> None:
    t, seen, _, _ = make([])
    with pytest.raises(LlmUnavailable, match="not allowed"):
        await post(t, model="other")
    assert seen == []


async def test_the_gate_can_stop_a_request_before_it_is_sent() -> None:
    t, seen, _, _ = make([], gate=Gate(refuse=True))
    with pytest.raises(LlmUnavailable, match="budget"):
        await post(t)
    assert seen == []


async def test_daily_request_limit_with_time_until_midnight() -> None:
    t, seen, _, _ = make([httpx.Response(200, json=OK)] * 2, rpd=2)
    await post(t)
    await post(t)
    with pytest.raises(LlmUnavailable) as caught:
        await post(t)
    assert caught.value.retry_after == 3600
    assert len(seen) == 2


async def test_requests_per_minute_waits_instead_of_bursting() -> None:
    sleeps = Sleeps()
    t, seen, _, _ = make([httpx.Response(200, json=OK)] * 3, rpm=2, sleeps=sleeps)
    for _ in range(3):
        await post(t)
    assert len(seen) == 3
    assert sum(sleeps.calls) == pytest.approx(30)


async def test_token_bucket_refills_over_time() -> None:
    s = Sleeps()
    bucket = TokenBucket(60, clock=s.clock, sleep=s)
    await bucket.take(60)
    await bucket.take(30)
    assert sum(s.calls) == pytest.approx(30)


async def test_reserves_the_worst_case_output_before_sending() -> None:
    t, _, gate, _ = make([httpx.Response(200, json=OK)] * 3)
    async with httpx.AsyncClient(transport=t, base_url="http://x") as client:
        await client.post("/chat/completions", json={"model": "m", "max_tokens": 300})
        await client.post("/chat/completions", json={"model": "m"})
        await client.post("/embeddings", json={"model": "m", "input": ["a"]})
    assert [out for _, out in gate.reserved] == [300, 1024, 0]
    assert all(tokens_in > 0 for tokens_in, _ in gate.reserved)
    assert len(gate.used) == 3 and gate.released == 0


async def test_a_failed_request_releases_its_reservation() -> None:
    t, _, gate, _ = make([httpx.Response(429)] * 3)
    assert (await post(t)).status_code == 429
    t2, _, gate2, _ = make([], rpd=0)
    with pytest.raises(LlmUnavailable, match="daily request limit"):
        await post(t2)
    assert gate.released == 1 and gate.used == []
    assert gate2.released == 1
