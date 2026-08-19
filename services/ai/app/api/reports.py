"""POST /internal/reports/nightly: the worker's reports.nightly job, one
workspace per call (worker JWT, scope reports:run)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.deps import ok, require_service, services
from app.auth import Caller
from app.reports.nightly import LocalStorage, run_nightly
from app.services import Services

router = APIRouter()
worker = require_service(frozenset({"worker"}), "reports:run")


class NightlyRequest(BaseModel):
    period: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


@router.post("/internal/reports/nightly")
async def nightly(
    body: NightlyRequest,
    caller: Annotated[Caller, Depends(worker)],
    svc: Annotated[Services, Depends(services)],
) -> dict[str, Any]:
    async with svc.sessions() as session:
        result = await run_nightly(
            session,
            LocalStorage(svc.settings.reports_dir),
            caller.workspace_id,
            period=body.period,
        )
    return ok(result)
