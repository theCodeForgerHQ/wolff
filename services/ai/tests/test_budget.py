from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import httpx2 as httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.budget import BudgetExceeded, BudgetGate, cost, metered
from app.db.session import session_factory
from app.llm.providers import resolve_provider
from app.llm.transport import LlmUnavailable, MemoryDailyCounter, RateLimitedTransport, Usage
from tests.conftest import requires_db

PROFILE = resolve_provider({"LLM_PROVIDER": "fake"})
NOW = datetime(2026, 10, 3, 18, 0, tzinfo=UTC)


def gate(engine: AsyncEngine, budget: str = "0.000100") -> BudgetGate:
    return BudgetGate(session_factory(engine), PROFILE, Decimal(budget), now=lambda: NOW)


def test_cost_uses_the_profile_prices() -> None:
    assert cost(PROFILE, Usage("m", 1_000_000, 1_000_000)) == Decimal("0.75")


@requires_db
async def test_reserves_the_worst_case_and_settles_to_the_real_cost(
    migrated: AsyncEngine,
) -> None:
    g = gate(migrated)  # budget 0.0001
    ws = f"ws-{uuid.uuid4()}"
    with metered(ws):
        held = await g.reserve("m", 400, 0)  # 0.00006
        assert await g.spent_today(ws) == Decimal("0.000060")
        # A second worst case would pass the budget while the first is held.
        with pytest.raises(BudgetExceeded) as caught:
            await g.reserve("m", 400, 0)
        await g.settle(held, Usage("m", 200, 0))  # really 0.00003
        assert await g.spent_today(ws) == Decimal("0.000030")
        again = await g.reserve("m", 400, 0)
        await g.settle(again, None)  # failed call: released
        assert await g.spent_today(ws) == Decimal("0.000030")
        with pytest.raises(BudgetExceeded):
            await g.reserve("m", 0, 200)  # 0.00012 alone is over the budget
    assert caught.value.retry_after == 6 * 3600


@requires_db
async def test_settling_records_tokens(migrated: AsyncEngine, engine: AsyncEngine) -> None:
    g = gate(migrated)
    ws = f"ws-{uuid.uuid4()}"
    with metered(ws):
        await g.settle(await g.reserve("m", 100, 100), Usage("m", 40, 20))
    async with engine.connect() as c:
        row = (
            await c.execute(
                text("SELECT tokens_in, tokens_out FROM ai.usage_daily WHERE workspace_id = :w"),
                {"w": ws},
            )
        ).one()
    assert tuple(row) == (40, 20)


@requires_db
async def test_budgets_are_per_workspace(migrated: AsyncEngine) -> None:
    g = gate(migrated)
    a, b = f"ws-{uuid.uuid4()}", f"ws-{uuid.uuid4()}"
    with metered(a):
        await g.settle(await g.reserve("m", 0, 0), Usage("m", 10_000, 0))
        with pytest.raises(BudgetExceeded):
            await g.reserve("m", 1, 0)
    with metered(b):
        await g.reserve("m", 1, 0)


@requires_db
async def test_a_call_with_no_workspace_is_refused(migrated: AsyncEngine) -> None:
    with pytest.raises(LlmUnavailable, match="metered"):
        await gate(migrated).reserve("m", 1, 0)


@requires_db
async def test_concurrent_queued_requests_cannot_overspend(migrated: AsyncEngine) -> None:
    """Requests waiting for a slot must not all pass the budget check at once:
    each reserves its worst case (prompt estimate + max_tokens) before it
    queues, and the reservations are settled to the real usage after."""
    out = 1_000
    budget = Decimal("0.002")  # room for three worst-case calls of ~0.0006
    release = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        await release.wait()
        usage = {"prompt_tokens": 10, "completion_tokens": out}
        return httpx.Response(200, json={"usage": usage, "choices": []})

    transport = RateLimitedTransport(
        httpx.MockTransport(handler),
        provider="fake",
        rpm=10_000,
        tpm=10_000_000,
        rpd=10_000,
        max_concurrency=1,
        allowed_models=frozenset({PROFILE.chat_model}),
        gate=gate(migrated, str(budget)),
        daily=MemoryDailyCounter(),
    )
    ws = f"ws-{uuid.uuid4()}"

    async def call(client: httpx.AsyncClient) -> int | str:
        try:
            body = {"model": PROFILE.chat_model, "max_tokens": out, "messages": []}
            return (await client.post("/chat/completions", json=body)).status_code
        except BudgetExceeded:
            return "refused"

    with metered(ws):
        async with httpx.AsyncClient(transport=transport, base_url="http://x") as client:
            calls = [asyncio.create_task(call(client)) for _ in range(10)]
            await asyncio.sleep(0.2)
            release.set()
            results = await asyncio.gather(*calls)

    assert results.count(200) == 3, results
    assert results.count("refused") == 7
    spent = await gate(migrated).spent_today(ws)
    one = cost(PROFILE, Usage(PROFILE.chat_model, 10, out)).quantize(Decimal("0.000001"))
    assert spent == 3 * one
    assert spent <= budget
