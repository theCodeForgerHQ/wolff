"""Per-workspace daily spend cap.

Every LLM request passes ``BudgetGate`` (it is the transport's UsageGate):
before sending, the workspace's spend for the UTC day is compared with
``AI_DAILY_BUDGET_USD``; after a successful response, its tokens and cost
are added to ``ai.usage_daily``. The workspace comes from a context
variable set by whoever starts the work (an authenticated request or a
job); a request with no workspace is refused, so nothing is unmetered.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import UsageDaily
from app.llm.providers import ProviderProfile
from app.llm.transport import LlmUnavailable, Usage

_workspace: ContextVar[str | None] = ContextVar("ai_workspace", default=None)
MILLION = Decimal(1_000_000)


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

    async def before(self, model: str) -> None:
        workspace = current_workspace()
        if workspace is None:
            raise LlmUnavailable("LLM call outside a metered workspace")
        if await self.spent_today(workspace) >= self._budget:
            now = self._now()
            midnight = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), UTC)
            raise BudgetExceeded(
                "daily AI budget exceeded", retry_after=(midnight - now).total_seconds()
            )

    async def after(self, usage: Usage) -> None:
        workspace = current_workspace()
        if workspace is None:
            return
        amount = cost(self._profile, usage)
        statement = insert(UsageDaily).values(
            workspace_id=workspace,
            day=self._today(),
            tokens_in=usage.tokens_in,
            tokens_out=usage.tokens_out,
            cost_usd=amount,
        )
        statement = statement.on_conflict_do_update(
            index_elements=[UsageDaily.workspace_id, UsageDaily.day],
            set_={
                "tokens_in": UsageDaily.tokens_in + usage.tokens_in,
                "tokens_out": UsageDaily.tokens_out + usage.tokens_out,
                "cost_usd": UsageDaily.cost_usd + amount,
            },
        )
        async with self._sessions() as session, session.begin():
            await session.execute(statement)
