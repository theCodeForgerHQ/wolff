"""POST /ingest and /ingest/sweep: called by the worker's ai.index jobs
with a worker JWT carrying scope ai:index."""

from __future__ import annotations

import time
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, exists, literal, or_, select, tuple_, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import ok, require_service, services
from app.auth import Caller
from app.budget import metered
from app.db.models import DocumentChunk, IngestState
from app.db.public_models import Client, ContractInstance, Invoice, Quote
from app.db.scoped import workspace_filter
from app.rag.ingest import ingest
from app.services import Services

router = APIRouter()
worker = require_service(frozenset({"worker"}), "ai:index")
# One sweep call has to finish well inside the caller's 60 s request timeout
# and Vercel's 300 s function limit, whatever the embedding provider's
# latency. It works off at most SWEEP_BATCH sources and stops starting new
# ones after SWEEP_SECONDS; "more" tells the caller to call again.
SWEEP_BATCH = 25
SWEEP_SECONDS = 40.0


class IngestRequest(BaseModel):
    source_type: Literal["quote", "invoice", "contract", "client_note"] = Field(alias="sourceType")
    source_id: str = Field(alias="sourceId", min_length=1, max_length=100)


@router.post("/ingest")
async def ingest_one(
    body: IngestRequest,
    caller: Annotated[Caller, Depends(worker)],
    svc: Annotated[Services, Depends(services)],
) -> dict[str, Any]:
    with metered(caller.workspace_id):
        async with svc.sessions() as session:
            result = await ingest(
                session,
                workspace_id=caller.workspace_id,
                source_type=body.source_type,
                source_id=body.source_id,
                embed=svc.llm.embed,
                embedding_model=svc.settings.provider.embed_model,
            )
    return ok({"outcome": result.outcome, "chunks": result.chunks})


@router.post("/ingest/sweep")
async def sweep(
    caller: Annotated[Caller, Depends(worker)],
    svc: Annotated[Services, Depends(services)],
) -> dict[str, Any]:
    """Re-index the workspace's sources changed since they were indexed or
    embedded with another model than the configured one, and drop the chunks
    and state of sources that are gone: deleted, soft-deleted, or a client
    whose notes were cleared."""
    ws = caller.workspace_id
    sources = _live_sources(ws)
    state = IngestState
    stale = (
        select(sources.c.kind, sources.c.id)
        .outerjoin(
            state,
            and_(
                state.source_type == sources.c.kind,
                state.source_id == sources.c.id,
                state.workspace_id == ws,
            ),
        )
        .where(
            or_(
                state.indexed_at.is_(None),
                state.source_updated_at < sources.c.updated,
                # Embedded with another model (AI_EMBED_MODEL changed): search
                # reads only the configured model's chunks, so re-embed.
                exists().where(
                    DocumentChunk.workspace_id == ws,
                    DocumentChunk.source_type == sources.c.kind,
                    DocumentChunk.source_id == sources.c.id,
                    DocumentChunk.embedding_model != svc.settings.provider.embed_model,
                ),
            )
        )
        .limit(SWEEP_BATCH + 1)
    )
    outcomes: dict[str, int] = {}
    deadline = time.monotonic() + SWEEP_SECONDS
    processed = 0
    with metered(ws):
        async with svc.sessions() as session:
            removed = await _remove_orphans(session, ws)
            rows = (await session.execute(stale)).all()
            for kind, source_id in rows[:SWEEP_BATCH]:
                # Always make progress: the first source runs even past the deadline.
                if processed and time.monotonic() >= deadline:
                    break
                result = await ingest(
                    session,
                    workspace_id=ws,
                    source_type=str(kind),
                    source_id=str(source_id),
                    embed=svc.llm.embed,
                    embedding_model=svc.settings.provider.embed_model,
                )
                outcomes[result.outcome] = outcomes.get(result.outcome, 0) + 1
                processed += 1
    more = processed < len(rows)
    return ok({"processed": processed, "outcomes": outcomes, "removed": removed, "more": more})


def _live_sources(ws: str) -> Any:
    """Every live source of the workspace as (id, updated, kind)."""
    return union_all(
        select(Quote.id.label("id"), Quote.updated_at.label("updated"))
        .add_columns(select_literal("quote"))
        .where(*workspace_filter(Quote, ws)),
        select(Invoice.id, Invoice.updated_at)
        .add_columns(select_literal("invoice"))
        .where(*workspace_filter(Invoice, ws)),
        select(ContractInstance.id, ContractInstance.updated_at)
        .add_columns(select_literal("contract"))
        .where(*workspace_filter(ContractInstance, ws)),
        select(Client.id, Client.updated_at)
        .add_columns(select_literal("client_note"))
        .where(*workspace_filter(Client, ws), Client.notes.is_not(None)),
    ).subquery()


async def _remove_orphans(session: AsyncSession, ws: str) -> int:
    """Delete chunks and ingest state whose source is no longer live. Commits."""
    live = _live_sources(ws)

    def gone(source_type: Any, source_id: Any) -> Any:
        return ~exists().where(live.c.kind == source_type, live.c.id == source_id)

    orphans = (
        select(DocumentChunk.source_type, DocumentChunk.source_id)
        .where(DocumentChunk.workspace_id == ws)
        .where(gone(DocumentChunk.source_type, DocumentChunk.source_id))
        .union(
            select(IngestState.source_type, IngestState.source_id)
            .where(IngestState.workspace_id == ws)
            .where(gone(IngestState.source_type, IngestState.source_id))
        )
    )
    keys = [(str(t), str(i)) for t, i in (await session.execute(orphans)).all()]
    if keys:
        await session.execute(
            delete(DocumentChunk).where(
                DocumentChunk.workspace_id == ws,
                tuple_(DocumentChunk.source_type, DocumentChunk.source_id).in_(keys),
            )
        )
        await session.execute(
            delete(IngestState).where(
                IngestState.workspace_id == ws,
                tuple_(IngestState.source_type, IngestState.source_id).in_(keys),
            )
        )
    await session.commit()
    return len(keys)


def select_literal(kind: str) -> Any:
    return literal(kind).label("kind")
