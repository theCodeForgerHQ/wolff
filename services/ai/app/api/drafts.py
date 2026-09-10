"""POST /drafts: the quote agent for the assistant panel."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.agent.errors import DraftError
from app.api.deps import error, ok, require_service, services
from app.auth import Caller
from app.services import Services

router = APIRouter()
web_user = require_service(frozenset({"web"}), "ai:use")


class DraftRequest(BaseModel):
    brief: str = Field(min_length=3, max_length=4_000)
    deal_id: str | None = Field(default=None, alias="dealId", max_length=100)


@router.post("/drafts", response_model=None)
async def create_draft(
    body: DraftRequest,
    caller: Annotated[Caller, Depends(web_user)],
    svc: Annotated[Services, Depends(services)],
) -> dict[str, Any] | JSONResponse:
    # Imported here: LangChain costs about a second of CPU on every cold
    # start, and most invocations (health checks, search) never need it.
    from app.agent.quote_agent import draft_quote

    try:
        result = await draft_quote(svc, caller, body.brief, body.deal_id)
    except DraftError as exc:
        return error(422, exc.code, str(exc))
    return ok(
        {
            "quoteId": result.quote_id,
            "quoteNumber": result.quote_number,
            "builderUrl": f"/quotes/{result.quote_id}/builder",
            "draft": result.draft.model_dump(),
            "gst": result.gst,
            "taxPending": result.tax_pending,
            "warnings": result.warnings,
        }
    )
