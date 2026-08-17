"""The AI service reads ``public`` and cannot write it."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.conftest import requires_db

WRITES = [
    "INSERT INTO public.workspaces (id, name, slug, updated_at) VALUES ('x', 'x', 'x', now())",
    "UPDATE public.invoices SET status = 'paid'",
    "DELETE FROM public.quotes",
    "TRUNCATE public.clients CASCADE",
    "CREATE TABLE public.ai_was_here (id int)",
]


@requires_db
async def test_the_service_can_read_public(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        assert (await conn.scalar(text("SELECT count(*) FROM public.quotes"))) is not None


@requires_db
@pytest.mark.parametrize("statement", WRITES)
async def test_the_service_cannot_write_public(engine: AsyncEngine, statement: str) -> None:
    async with engine.connect() as conn:
        with pytest.raises(DBAPIError, match="permission denied"):
            await conn.execute(text(statement))
        await conn.rollback()
