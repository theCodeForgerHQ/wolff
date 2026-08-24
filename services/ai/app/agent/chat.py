"""The assistant's chat turn.

A tool-calling agent (LangChain ``create_agent``) routes each question to
SQL tools or to document search. Events are produced as the agent works:
``tool_call`` when it calls a tool, then ``token`` events with the
answer, ``citation`` events for the documents it cited, and ``done``.
The answer is checked before any of it is sent: when the only evidence
was a search that found nothing, the fixed "not found" sentence replaces
whatever the model wrote, and citation numbers that match no returned
document are removed.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import anyio
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage
from sqlalchemy import select

from app.agent.tools import Evidence, chat_tools
from app.auth import Caller
from app.budget import cost, metered
from app.db.models import AgentRun, ChatMessage, ChatSession
from app.llm.clients import is_fallback_error
from app.llm.providers import ProviderProfile
from app.llm.transport import Usage
from app.prompts import load_prompt
from app.services import Services

NOT_FOUND = "I couldn't find that in your documents."
MAX_TOOL_ITERATIONS = 8
WALL_CLOCK_SECONDS = 60
HISTORY_TURNS = 10
_CITATION = re.compile(r"\[(\d+)\]")
#: Some models (NIM's Nemotron) cite with full-width lenticular brackets.
_WIDE_CITATION = re.compile(r"【\s*(\d+)\s*】")


@dataclass(frozen=True)
class ChatEvent:
    event: str
    data: dict[str, Any]


def finalize_answer(answer: str, evidence: Evidence) -> tuple[str, list[dict[str, Any]]]:
    """Apply the not-found guard and keep only citations that exist."""
    only_search = evidence.searched and set(evidence.tools_used) == {"search_documents"}
    if only_search and not evidence.documents:
        return NOT_FOUND, []
    known = {d["n"]: d for d in evidence.documents}
    cited: list[dict[str, Any]] = []

    def keep(match: re.Match[str]) -> str:
        n = int(match.group(1))
        if n not in known:
            return ""
        if all(c["n"] != n for c in cited):
            doc = known[n]
            cited.append({k: doc[k] for k in ("n", "source_type", "source_id", "label")})
        return match.group(0)

    cleaned = _CITATION.sub(keep, _WIDE_CITATION.sub(r"[\1]", answer)).strip()
    return cleaned or NOT_FOUND, cited


async def _session_for(svc: Services, caller: Caller, session_id: str | None, title: str) -> str:
    """The caller's own session, or a new one. A session id of another user or
    workspace is not an error: it is ignored and a new session started."""
    async with svc.sessions() as db, db.begin():
        if session_id:
            owned = await db.scalar(
                select(ChatSession.id).where(
                    ChatSession.id == session_id,
                    ChatSession.workspace_id == caller.workspace_id,
                    ChatSession.user_id == (caller.user_id or ""),
                )
            )
            if owned:
                return owned
        created = ChatSession(
            workspace_id=caller.workspace_id, user_id=caller.user_id or "", title=title[:120]
        )
        db.add(created)
        await db.flush()
        return created.id


async def _history(svc: Services, session_id: str) -> list[AnyMessage]:
    async with svc.sessions() as db:
        rows = list(
            await db.scalars(
                select(ChatMessage)
                .where(ChatMessage.session_id == session_id)
                .order_by(ChatMessage.created_at.desc())
                .limit(HISTORY_TURNS * 2)
            )
        )
    messages: list[AnyMessage] = []
    for row in reversed(rows):
        messages.append(HumanMessage(row.content) if row.role == "user" else AIMessage(row.content))
    return messages


async def run_chat(
    svc: Services, caller: Caller, message: str, session_id: str | None = None
) -> AsyncIterator[ChatEvent]:
    caller.require("ai:use")
    started = time.monotonic()
    prompt = load_prompt("chat")
    sid = await _session_for(svc, caller, session_id, message)
    yield ChatEvent("session", {"sessionId": sid})

    attempts = svc.llm.chat_attempts()
    profile = attempts[0][0]
    evidence = Evidence()
    usage = Usage(model=profile.chat_model, tokens_in=0, tokens_out=0)
    final = ""
    tool_calls: list[dict[str, Any]] = []
    status, error = "ok", None

    try:
        history = await _history(svc, sid)
        with metered(caller.workspace_id):
            async with asyncio.timeout(WALL_CLOCK_SECONDS):
                # The fallback provider (LLM_FALLBACK) gets the question again
                # from the start if the first one fails as a provider.
                for attempt, (profile, model) in enumerate(attempts):
                    # A fallback starts over: nothing the failed attempt
                    # found, called or spent belongs to its answer.
                    evidence, tool_calls, final = Evidence(), [], ""
                    usage = Usage(model=profile.chat_model, tokens_in=0, tokens_out=0)
                    tools = chat_tools(
                        workspace_id=caller.workspace_id,
                        sessions=svc.sessions,
                        embed=svc.llm.embed_queries,
                        embedding_model=svc.settings.provider.embed_model,
                        evidence=evidence,
                    )
                    agent = create_agent(model, tools=tools, system_prompt=prompt.text)
                    try:
                        stream = agent.astream(
                            {"messages": [*history, HumanMessage(message)]},
                            config={"recursion_limit": MAX_TOOL_ITERATIONS * 2 + 1},
                            stream_mode="updates",
                        )
                        async for update in stream:
                            for node in update.values():
                                for msg in (node or {}).get("messages", []):
                                    if not isinstance(msg, AIMessage):
                                        continue
                                    meta: dict[str, Any] = dict(msg.usage_metadata or {})
                                    usage = Usage(
                                        usage.model,
                                        usage.tokens_in + int(meta.get("input_tokens", 0)),
                                        usage.tokens_out + int(meta.get("output_tokens", 0)),
                                    )
                                    for call in msg.tool_calls:
                                        tool_calls.append(
                                            {"name": call["name"], "args": call["args"]}
                                        )
                                        yield ChatEvent("tool_call", {"name": call["name"]})
                                    if not msg.tool_calls:
                                        final = _text(msg.content)
                        break
                    except Exception as exc:
                        if attempt == len(attempts) - 1 or not is_fallback_error(exc):
                            raise
    except Exception as exc:
        status, error = "error", type(exc).__name__
        raise
    except BaseException:
        # The client disconnected: the server cancels the stream or closes
        # the generator.
        status, error = "cancelled", "client_disconnected"
        raise
    finally:
        answer, citations = finalize_answer(final, evidence) if status == "ok" else ("", [])
        # Shielded: a cancelled request must still leave its agent_runs row.
        with anyio.CancelScope(shield=True):
            await _record(
                svc,
                caller,
                sid,
                message,
                answer,
                citations,
                tool_calls,
                usage,
                profile,
                prompt.version,
                status,
                error,
                started,
            )

    for word in re.findall(r"\S+\s*", answer):
        yield ChatEvent("token", {"text": word})
    for citation in citations:
        yield ChatEvent("citation", citation)
    yield ChatEvent("done", {"sessionId": sid})


def _text(content: object) -> str:
    """A message's text. Reasoning models may answer with a list of content
    blocks (text and reasoning); only the text blocks are the answer."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(block.get("text", "")) if isinstance(block, dict) else str(block)
            for block in content
            if not isinstance(block, dict) or block.get("type", "text") == "text"
        )
    return str(content)


async def _record(
    svc: Services,
    caller: Caller,
    session_id: str,
    question: str,
    answer: str,
    citations: list[dict[str, Any]],
    tool_calls: list[dict[str, Any]],
    usage: Usage,
    profile: ProviderProfile,
    prompt_version: str,
    status: str,
    error: str | None,
    started: float,
) -> None:
    spent = cost(profile, usage)
    async with svc.sessions() as db, db.begin():
        db.add(ChatMessage(session_id=session_id, role="user", content=question))
        if status == "ok":
            db.add(
                ChatMessage(
                    session_id=session_id,
                    role="assistant",
                    content=answer,
                    tool_calls=tool_calls,
                    citations=citations,
                    tokens_in=usage.tokens_in,
                    tokens_out=usage.tokens_out,
                    cost_usd=spent,
                )
            )
        db.add(
            AgentRun(
                workspace_id=caller.workspace_id,
                kind="chat",
                prompt_version=prompt_version,
                input={"message": question, "session_id": session_id},
                output={
                    "answer": answer,
                    "citations": citations,
                    "tool_calls": tool_calls,
                    "model": usage.model,
                },
                status=status,
                latency_ms=int((time.monotonic() - started) * 1000),
                tokens=usage.tokens_in + usage.tokens_out,
                cost_usd=spent if spent else Decimal(0),
                error=error,
            )
        )
