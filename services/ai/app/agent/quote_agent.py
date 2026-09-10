"""The quote-drafting agent.

1. A tool-calling agent gathers facts: the client, matching rate cards,
   the client's past quotes, the deal, documents. Tools close over the
   caller's workspace.
2. The model returns a ``QuoteDraft`` through strict json_schema output.
   An invalid output gets one repair attempt, then the run fails.
3. Our code checks the draft against the workspace before anything is
   written: the client must be one of its clients, the deal one of its
   deals, every rate-card reference one of its rate cards. A draft that
   fails is not created.
4. GST is priced by apps/api (one implementation). If apps/api cannot be
   reached the draft is still produced, marked ``tax_pending``.
5. apps/api creates the quote as a draft, acting as the caller.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from decimal import Decimal
from functools import partial
from typing import Any

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage
from langchain_core.tools import BaseTool, StructuredTool
from pydantic import ValidationError

from app.agent import queries
from app.agent.api_client import ApiError, ApiUnavailable
from app.agent.errors import DraftError
from app.agent.schemas import QuoteDraft
from app.auth import Caller
from app.budget import cost, metered
from app.db.models import AgentRun
from app.db.public_models import BusinessProfile
from app.db.scoped import scoped
from app.llm.transport import Usage
from app.prompts import load_prompt
from app.services import Services

MAX_TOOL_ITERATIONS = 8
WALL_CLOCK_SECONDS = 60
DEFAULT_GST_RATE = 18.0


@dataclass
class DraftResult:
    quote_id: str
    quote_number: str
    draft: QuoteDraft
    gst: dict[str, Any] | None
    tax_pending: bool
    warnings: list[str] = field(default_factory=list)


def _dump(value: object) -> str:
    return json.dumps(value, default=str)


def _tools(svc: Services, ws: str) -> list[BaseTool]:
    async def read(fn: Any, *args: Any) -> str:
        async with svc.sessions() as session:
            return _dump(await fn(session, ws, *args))

    async def get_client(ref: str) -> str:
        """Find the client by id or name."""
        return await read(queries.find_client, ref)

    async def list_rate_cards(query: str | None = None) -> str:
        """The workspace's active rate cards, optionally filtered by a word."""
        return await read(queries.list_rate_cards, query)

    async def get_past_quotes(client_id: str | None = None) -> str:
        """Recent quotes, optionally for one client."""
        return await read(queries.past_quotes, client_id)

    async def get_deal(deal_id: str) -> str:
        """One deal by id."""
        return await read(queries.get_deal, deal_id)

    return [
        StructuredTool.from_function(coroutine=fn)
        for fn in (get_client, list_rate_cards, get_past_quotes, get_deal)
    ]


async def _gather(svc: Services, ws: str, brief: str, system: str) -> list[AnyMessage]:
    async def run(model: Any) -> list[AnyMessage]:
        agent = create_agent(model, tools=_tools(svc, ws), system_prompt=system)
        result = await agent.ainvoke(
            {"messages": [HumanMessage(brief)]},
            config={"recursion_limit": MAX_TOOL_ITERATIONS * 2 + 1},
        )
        messages: list[AnyMessage] = result["messages"]
        return messages

    return await svc.llm.run_chat(run)


async def _structured(svc: Services, messages: list[AnyMessage]) -> tuple[QuoteDraft, Usage]:
    async def structured(model: Any, sent: list[AnyMessage]) -> dict[str, Any]:
        runnable = model.with_structured_output(
            QuoteDraft, method="json_schema", strict=True, include_raw=True
        )
        result: dict[str, Any] = await runnable.ainvoke(sent)
        return result

    usage = Usage(svc.settings.provider.chat_model, 0, 0)
    attempt = list(messages)
    for _ in range(2):  # the first try and one repair
        try:
            sent = list(attempt)
            out = await svc.llm.run_chat(partial(structured, sent=sent))
        except ValidationError as exc:
            # The SDK's own parse of the json_schema output failed.
            out = {"raw": None, "parsed": None, "parsing_error": exc}
        raw = out.get("raw")
        if isinstance(raw, AIMessage) and raw.usage_metadata:
            usage = Usage(
                usage.model,
                usage.tokens_in + raw.usage_metadata["input_tokens"],
                usage.tokens_out + raw.usage_metadata["output_tokens"],
            )
        parsed = out.get("parsed")
        if isinstance(parsed, QuoteDraft) and out.get("parsing_error") is None:
            return parsed, usage
        error = out.get("parsing_error")
        attempt = [
            *attempt,
            *([raw] if isinstance(raw, AIMessage) else []),
            HumanMessage(f"That output was invalid ({error}). Return a valid QuoteDraft."),
        ]
    raise DraftError("invalid_output", "The model did not return a valid draft")


async def validate_against_workspace(
    svc: Services, ws: str, draft: QuoteDraft
) -> tuple[QuoteDraft, list[str]]:
    """Refuse a draft that names anything outside the workspace, and return
    it with every value the workspace already knows taken from there, plus
    warnings for what the user must confirm.

    Text the model read while drafting (a contract, a note) may carry
    instructions, so nothing it could be steered into is trusted where a
    real value exists: a rate-card line's rate and HSN/SAC come from the
    card (its GST rate is looked up by card id later), and the currency is
    the workspace's. A past-quote or new line keeps the model's price and
    is listed in the warnings as priced by the assistant. Quantity, line
    count and field lengths are bounded by the QuoteDraft schema.
    """
    async with svc.sessions() as session:
        client = (
            await queries.find_client(session, ws, draft.client_id) if draft.client_id else None
        )
        if client is None or client["client_id"] != draft.client_id:
            raise DraftError("unknown_client", "The draft does not name a client of this workspace")
        if draft.deal_id:
            deal = await queries.get_deal(session, ws, draft.deal_id)
            if deal is None:
                raise DraftError("unknown_deal", "The draft names a deal outside this workspace")
            if deal["client_id"] and deal["client_id"] != draft.client_id:
                raise DraftError("unknown_deal", "The draft's deal belongs to another client")
        cards = {c["rate_card_id"]: c for c in await queries.list_rate_cards(session, ws)}
        currency = await session.scalar(
            scoped(BusinessProfile, ws).with_only_columns(BusinessProfile.currency)
        )
    lines = []
    warnings: list[str] = []
    for line in draft.line_items:
        if line.source != "rate_card":
            warnings.append(
                f"Line {line.name!r} is priced by the assistant, not a rate card: confirm the price"
            )
            lines.append(line)
            continue
        card = cards.get(line.source_ref or "")
        if card is None:
            raise DraftError("unknown_rate_card", f"Line {line.name!r} cites an unknown rate card")
        lines.append(line.model_copy(update={"rate": card["rate"], "hsn_sac": card["hsn_sac"]}))
    update: dict[str, Any] = {"line_items": lines}
    if currency:
        update["currency"] = currency
    return draft.model_copy(update=update), warnings


async def _gst(
    svc: Services, caller: Caller, draft: QuoteDraft, rates: dict[str, float | None]
) -> tuple[dict[str, Any] | None, bool, list[str]]:
    lines = [
        {
            "name": line.name,
            "quantity": line.qty,
            "rate": line.rate,
            "gstRate": rates.get(line.source_ref or "") or DEFAULT_GST_RATE,
            **({"hsnSac": line.hsn_sac} if line.hsn_sac else {}),
        }
        for line in draft.line_items
    ]
    try:
        priced = await svc.api.post(
            caller,
            "/internal/gst/compute",
            {"clientId": draft.client_id, "lines": lines},
            {"quotes:write"},
        )
        return priced, False, []
    except ApiUnavailable:
        return None, True, ["GST will be calculated on save: the API could not be reached"]
    except ApiError as exc:
        return None, True, [f"GST not priced: {exc.message}"]


async def draft_quote(
    svc: Services, caller: Caller, brief: str, deal_id: str | None = None
) -> DraftResult:
    caller.require("quotes:write")
    ws = caller.workspace_id
    prompt = load_prompt("quote_draft")
    started = time.monotonic()
    status, error, result = "error", None, None
    usage = Usage(svc.settings.provider.chat_model, 0, 0)
    request = brief if not deal_id else f"{brief}\n(deal id: {deal_id})"
    try:
        with metered(ws):
            async with asyncio.timeout(WALL_CLOCK_SECONDS):
                messages = await _gather(svc, ws, request, prompt.text)
                draft, usage = await _structured(svc, [SystemMessage(prompt.text), *messages[-12:]])
        if deal_id:
            draft = draft.model_copy(update={"deal_id": deal_id})
        draft, checks = await validate_against_workspace(svc, ws, draft)
        async with svc.sessions() as session:
            rates = {
                c["rate_card_id"]: c["gst_rate"] for c in await queries.list_rate_cards(session, ws)
            }
        gst, tax_pending, warnings = await _gst(svc, caller, draft, rates)
        try:
            created = await svc.api.post(
                caller,
                "/internal/quotes/draft",
                {
                    "clientId": draft.client_id,
                    "dealId": draft.deal_id,
                    "title": draft.title,
                    "currency": draft.currency,
                    "lineItems": [
                        {
                            "name": line.name,
                            "description": line.description,
                            "quantity": line.qty,
                            "unit": line.unit,
                            "rate": line.rate,
                            "hsnSac": line.hsn_sac,
                            "gstRate": rates.get(line.source_ref or ""),
                            "source": line.source,
                            "sourceRef": line.source_ref,
                        }
                        for line in draft.line_items
                    ],
                    "terms": draft.terms,
                    "notes": draft.notes,
                    "assumptions": draft.assumptions,
                },
                {"quotes:write"},
            )
        except ApiError as exc:
            raise DraftError("rejected", exc.message) from exc
        except ApiUnavailable as exc:
            raise DraftError("api_unavailable", "The quote could not be saved; try again") from exc
        result = DraftResult(
            created["quoteId"], created["quoteNumber"], draft, gst, tax_pending, checks + warnings
        )
        status = "ok"
        return result
    except DraftError as exc:
        error = exc.code
        raise
    except ValidationError as exc:
        error = "invalid_output"
        raise DraftError("invalid_output", "The model did not return a valid draft") from exc
    finally:
        spent = cost(svc.settings.provider, usage)
        async with svc.sessions() as session, session.begin():
            session.add(
                AgentRun(
                    workspace_id=ws,
                    kind="quote_draft",
                    prompt_version=prompt.version,
                    input={"brief": brief, "deal_id": deal_id},
                    output=(
                        {
                            "quote_id": result.quote_id,
                            "draft": result.draft.model_dump(),
                            "tax_pending": result.tax_pending,
                        }
                        if result
                        else None
                    ),
                    status=status,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    tokens=usage.tokens_in + usage.tokens_out,
                    cost_usd=spent or Decimal(0),
                    error=error,
                )
            )
