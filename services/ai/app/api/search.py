"""POST /search: the retriever over HTTP for the web app (scope ai:use)."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.deps import ok, require_service, services
from app.auth import Caller
from app.budget import metered
from app.rag.retriever import WorkspaceRetriever
from app.services import Services

router = APIRouter()
web_user = require_service(frozenset({"web"}), "ai:use")
SourceType = Literal["quote", "invoice", "contract", "client_note"]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2_000)
    types: list[SourceType] | None = None


def retriever_for(svc: Services, workspace_id: str, types: list[str] | None) -> WorkspaceRetriever:
    return WorkspaceRetriever(
        sessions=svc.sessions,
        workspace_id=workspace_id,
        embed=svc.llm.embed,
        embedding_model=svc.settings.provider.embed_model,
        source_types=types,
    )


@router.post("/search")
async def search(
    body: SearchRequest,
    caller: Annotated[Caller, Depends(web_user)],
    svc: Annotated[Services, Depends(services)],
) -> dict[str, Any]:
    with metered(caller.workspace_id):
        docs = await retriever_for(svc, caller.workspace_id, list(body.types or [])).search(
            body.query
        )
    return ok([{"content": d.page_content, "metadata": d.metadata} for d in docs])
