"""Process-wide services, built once at start and shared by requests."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.agent.api_client import ApiClient
from app.auth import MemoryReplayCache, RedisReplayCache, ReplayCache, ServiceJwtVerifier
from app.budget import BudgetGate
from app.db.session import create_engine, session_factory
from app.llm.clients import LlmClients, build_clients
from app.llm.transport import DailyCounter, MemoryDailyCounter, RedisDailyCounter
from app.settings import Settings


@dataclass
class Services:
    settings: Settings
    engine: AsyncEngine
    sessions: async_sessionmaker[AsyncSession]
    llm: LlmClients
    budget: BudgetGate
    #: Verifies tokens from the web app (chat) and the worker (indexing).
    verifier: ServiceJwtVerifier
    api: ApiClient
    redis: Any = None

    async def aclose(self) -> None:
        await self.llm.aclose()
        await self.api.aclose()
        await self.engine.dispose()
        if self.redis is not None:
            await self.redis.aclose()


def build_services(
    settings: Settings, *, engine: AsyncEngine | None = None, api: ApiClient | None = None
) -> Services:
    if engine is None:
        if not settings.database_url:
            raise RuntimeError("AI_DATABASE_URL is not set")
        engine = create_engine(settings.database_url)
    sessions = session_factory(engine)

    redis: Any = None
    replay: ReplayCache
    daily: DailyCounter
    if settings.redis_url:
        from redis.asyncio import Redis

        redis = Redis.from_url(settings.redis_url)
        replay, daily = RedisReplayCache(redis), RedisDailyCounter(redis)
    else:
        replay, daily = MemoryReplayCache(), MemoryDailyCounter()

    budget = BudgetGate(sessions, settings.provider, settings.daily_budget_usd)
    llm = build_clients(settings.provider, gate=budget, daily=daily, max_tokens=settings.max_tokens)
    verifier = ServiceJwtVerifier(
        secrets={"web": settings.svc_jwt_secret_web, "worker": settings.svc_jwt_secret_worker},
        issuers=("web", "worker"),
        audience="ai",
        replay_cache=replay,
    )
    api = api or ApiClient(settings.api_url, settings.svc_jwt_secret_ai)
    return Services(settings, engine, sessions, llm, budget, verifier, api, redis)
