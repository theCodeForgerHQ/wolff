from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from app.budget import BudgetExceeded, BudgetGate, cost, metered
from app.db.session import session_factory
from app.llm.providers import resolve_provider
from app.llm.transport import LlmUnavailable, Usage
from tests.conftest import requires_db

PROFILE = resolve_provider({"LLM_PROVIDER": "fake"})
NOW = datetime(2026, 10, 3, 18, 0, tzinfo=UTC)


def gate(engine: AsyncEngine, budget: str = "0.000100") -> BudgetGate:
    return BudgetGate(session_factory(engine), PROFILE, Decimal(budget), now=lambda: NOW)


def test_cost_uses_the_profile_prices() -> None:
    assert cost(PROFILE, Usage("m", 1_000_000, 1_000_000)) == Decimal("0.75")


@requires_db
async def test_refuses_once_the_daily_budget_is_spent(migrated: AsyncEngine) -> None:
    g = gate(migrated)
    ws = f"ws-{uuid.uuid4()}"
    with metered(ws):
        await g.before("m")
        await g.after(Usage("m", 400, 0))  # 0.00006
        await g.before("m")
        await g.after(Usage("m", 400, 0))  # 0.00012 >= 0.0001
        with pytest.raises(BudgetExceeded) as caught:
            await g.before("m")
    assert caught.value.retry_after == 6 * 3600
    assert await g.spent_today(ws) == Decimal("0.000120")


@requires_db
async def test_budgets_are_per_workspace(migrated: AsyncEngine) -> None:
    g = gate(migrated)
    a, b = f"ws-{uuid.uuid4()}", f"ws-{uuid.uuid4()}"
    with metered(a):
        await g.after(Usage("m", 10_000, 0))
        with pytest.raises(BudgetExceeded):
            await g.before("m")
    with metered(b):
        await g.before("m")


@requires_db
async def test_a_call_with_no_workspace_is_refused(migrated: AsyncEngine) -> None:
    with pytest.raises(LlmUnavailable, match="metered"):
        await gate(migrated).before("m")
