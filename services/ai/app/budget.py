"""Per-workspace daily spend cap.

Every LLM request passes ``BudgetGate`` (it is the transport's UsageGate).
Before it waits for a slot, the request reserves its worst-case cost
(estimated prompt tokens plus its max_tokens) in ``ai.usage_daily`` with
one conditional upsert, which is refused when the day's spend plus the
reservation would pass ``AI_DAILY_BUDGET_USD``. Because the check and the
increment are one row-locked statement, requests queued at the same time
cannot all pass on the same stale total. Afterwards the reservation is
replaced by the real tokens and cost, or released if the call failed. So
``cost_usd`` includes in-flight reservations. The workspace comes from a context
variable set by whoever starts the work (an authenticated request or a
job); a request with no workspace is refused, so nothing is unmetered.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_CEILING, Decimal

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import UsageDaily
from app.llm.providers import ProviderProfile
from app.llm.transport import LlmUnavailable, Usage

_workspace: ContextVar[str | None] = ContextVar("ai_workspace", default=None)
MILLION = Decimal(1_000_000)
#: ai.usage_daily.cost_usd is numeric(10, 6).
USD_STEP = Decimal("0.000001")


class BudgetExceeded(LlmUnavailable):
    """The workspace has spent its daily budget (HTTP 429 ai_budget_exceeded)."""


@contextmanager
def metered(workspace_id: str) -> Iterator[None]:
    """Charge LLM calls made inside this block to ``workspace_id``."""
    token = _workspace.set(workspace_id)
    try:
        yield
    finally:
        _workspace.reset(token)


def current_workspace() -> str | None:
    return _workspace.get()


def cost(profile: ProviderProfile, usage: Usage) -> Decimal:
    return (usage.tokens_in * profile.price_in + usage.tokens_out * profile.price_out) / MILLION


@dataclass(frozen=True, slots=True)
class Reservation:
    """Cost held for one in-flight request, on the day it was made."""

    workspace_id: str
    day: date
    amount: Decimal


class BudgetGate:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        profile: ProviderProfile,
        daily_budget_usd: Decimal,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._sessions = sessions
        self._profile = profile
        self._budget = daily_budget_usd
        self._now = now

    def _today(self) -> date:
        return self._now().date()

    async def spent_today(self, workspace_id: str) -> Decimal:
        async with self._sessions() as session:
            value = await session.scalar(
                select(UsageDaily.cost_usd).where(
                    UsageDaily.workspace_id == workspace_id, UsageDaily.day == self._today()
                )
            )
        return value or Decimal(0)

    def _exceeded(self) -> BudgetExceeded:
        now = self._now()
        midnight = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), UTC)
        return BudgetExceeded(
            "daily AI budget exceeded", retry_after=(midnight - now).total_seconds()
        )

    async def reserve(self, model: str, tokens_in: int, max_tokens_out: int) -> Reservation:
        workspace = current_workspace()
        if workspace is None:
            raise LlmUnavailable("LLM call outside a metered workspace")
        # Rounded up to the column's 6 places, so settling subtracts exactly
        # what was stored.
        amount = cost(self._profile, Usage(model, tokens_in, max_tokens_out)).quantize(
            USD_STEP, ROUND_CEILING
        )
        if amount > self._budget:
            raise self._exceeded()
        day = self._today()
        statement = (
            insert(UsageDaily)
            .values(workspace_id=workspace, day=day, tokens_in=0, tokens_out=0, cost_usd=amount)
            .on_conflict_do_update(
                index_elements=[UsageDaily.workspace_id, UsageDaily.day],
                set_={"cost_usd": UsageDaily.cost_usd + amount},
                where=UsageDaily.cost_usd + amount <= self._budget,
            )
            .returning(UsageDaily.cost_usd)
        )
        async with self._sessions() as session, session.begin():
            held = (await session.execute(statement)).scalar_one_or_none()
        if held is None:
            raise self._exceeded()
        return Reservation(workspace, day, amount)

    async def settle(self, reservation: object, usage: Usage | None) -> None:
        if not isinstance(reservation, Reservation):
            raise TypeError("not a BudgetGate reservation")
        actual = cost(self._profile, usage).quantize(USD_STEP) if usage else Decimal(0)
        statement = (
            update(UsageDaily)
            .where(
                UsageDaily.workspace_id == reservation.workspace_id,
                UsageDaily.day == reservation.day,
            )
            .values(
                tokens_in=UsageDaily.tokens_in + (usage.tokens_in if usage else 0),
                tokens_out=UsageDaily.tokens_out + (usage.tokens_out if usage else 0),
                cost_usd=UsageDaily.cost_usd - reservation.amount + actual,
            )
        )
        async with self._sessions() as session, session.begin():
            await session.execute(statement)
