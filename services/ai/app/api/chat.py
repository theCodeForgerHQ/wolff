"""POST /chat/stream: server-sent events for the assistant panel.

Events: ``session``, ``tool_call``, ``token``, ``citation``, ``done`` and
``error``. The web app proxies this with a 60 s web JWT (scope ai:use).
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.deps import require_service, services
from app.auth import Caller
from app.budget import BudgetExceeded
from app.llm.transport import LlmUnavailable
from app.services import Services

router = APIRouter()
web_user = require_service(frozenset({"web"}), "ai:use")
log = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4_000)
    session_id: str | None = Field(default=None, alias="sessionId", max_length=100)


def sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.post("/chat/stream")
async def chat_stream(
    body: ChatRequest,
    caller: Annotated[Caller, Depends(web_user)],
    svc: Annotated[Services, Depends(services)],
) -> StreamingResponse:
    # Imported here: LangChain costs about a second of CPU on every cold
    # start, and most invocations (health checks, search) never need it.
    from app.agent.chat import run_chat

    async def events() -> AsyncIterator[str]:
        try:
            async for item in run_chat(svc, caller, body.message, body.session_id):
                yield sse(item.event, item.data)
        except BudgetExceeded as exc:
            yield sse("error", {"code": "ai_budget_exceeded", "retryAfter": exc.retry_after})
        except LlmUnavailable as exc:
            yield sse("error", {"code": "ai_unavailable", "retryAfter": exc.retry_after})
        except TimeoutError:
            yield sse("error", {"code": "ai_timeout"})
        except Exception:
            log.exception("chat turn failed")
            yield sse("error", {"code": "ai_error"})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
