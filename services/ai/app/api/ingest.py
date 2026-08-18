"""POST /ingest and /ingest/sweep: called by the worker's ai.index jobs
with a worker JWT carrying scope ai:index."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select, union_all

from app.api.deps import ok, require_service, services
from app.auth import Caller
from app.budget import metered
from app.db.models import IngestState
from app.db.public_models import Client, ContractInstance, Invoice, Quote
from app.db.scoped import workspace_filter
from app.rag.ingest import ingest
from app.services import Services

router = APIRouter()
worker = require_service(frozenset({"worker"}), "ai:index")
SWEEP_LIMIT = 200


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
    """Re-index the workspace's sources changed since they were indexed."""
    ws = caller.workspace_id
    sources = union_all(
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
        .where(or_(state.indexed_at.is_(None), state.source_updated_at < sources.c.updated))
        .limit(SWEEP_LIMIT)
    )
    outcomes: dict[str, int] = {}
    with metered(ws):
        async with svc.sessions() as session:
            rows = (await session.execute(stale)).all()
            for kind, source_id in rows:
                result = await ingest(
                    session,
                    workspace_id=ws,
                    source_type=str(kind),
                    source_id=str(source_id),
                    embed=svc.llm.embed,
                    embedding_model=svc.settings.provider.embed_model,
                )
                outcomes[result.outcome] = outcomes.get(result.outcome, 0) + 1
    return ok({"processed": len(rows), "outcomes": outcomes})


def select_literal(kind: str) -> Any:
    from sqlalchemy import literal

    return literal(kind).label("kind")
