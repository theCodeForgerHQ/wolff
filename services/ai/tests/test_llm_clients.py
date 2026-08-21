from __future__ import annotations

import math
import re
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx2 as httpx
import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from app.agent.schemas import QuoteDraft
from app.llm.clients import build_clients, fit_dimensions
from app.llm.fake import FakeOpenAITransport, embed
from app.llm.providers import resolve_provider
from app.llm.transport import MemoryDailyCounter, Usage


class Gate:
    def __init__(self) -> None:
        self.used: list[Usage] = []

    async def reserve(self, model: str, tokens_in: int, max_tokens_out: int) -> object:
        return None

    async def settle(self, reservation: object, usage: Usage | None) -> None:
        if usage is not None:
            self.used.append(usage)


def clients(gate: Gate):  # type: ignore[no-untyped-def]
    return build_clients(
        resolve_provider({"LLM_PROVIDER": "fake"}), gate=gate, daily=MemoryDailyCounter()
    )


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


async def test_embeddings_go_through_the_gate_and_keep_order() -> None:
    gate = Gate()
    llm = clients(gate)
    vectors = await llm.embed(["website redesign", "logo design", "website redesign"])
    await llm.aclose()
    assert len(vectors) == 3 and all(len(v) == 1536 for v in vectors)
    assert vectors[0] == vectors[2]
    assert math.isclose(sum(v * v for v in vectors[1]), 1.0, rel_tol=1e-9)
    assert [u.model for u in gate.used] == ["fake-embed"]


def test_fake_embeddings_are_lexical() -> None:
    q = embed("invoice for the website redesign")
    assert cosine(q, embed("Website redesign, phase two")) > cosine(
        q, embed("Annual audit retainer")
    )


async def test_chat_model_calls_a_tool_through_the_shared_transport() -> None:
    @tool
    def search_documents(query: str) -> str:
        """Search."""
        return query

    gate = Gate()
    llm = clients(gate)
    reply = (
        await llm.chat_model()
        .bind_tools([search_documents])
        .ainvoke([HumanMessage("what did we quote Acme?")])
    )
    await llm.aclose()
    assert reply.tool_calls[0]["name"] == "search_documents"
    assert reply.tool_calls[0]["args"] == {"query": "what did we quote Acme?"}
    assert [u.model for u in gate.used] == ["fake-chat"]
    assert gate.used[0].tokens_in > 0


def test_fit_dimensions_truncates_and_normalises() -> None:
    out = fit_dimensions([3.0, 4.0] + [0.0] * 3000, 1536)
    assert len(out) == 1536 and out[:2] == [0.6, 0.8]
    with pytest.raises(ValueError, match="dimensions"):
        fit_dimensions([1.0] * 10)


class OrderGate:
    """Logs reserve/settle; the inner transport logs each send."""

    def __init__(self, log: list[str]) -> None:
        self.log = log

    async def reserve(self, model: str, tokens_in: int, max_tokens_out: int) -> object:
        self.log.append("reserve")
        return len(self.log)

    async def settle(self, reservation: object, usage: Usage | None) -> None:
        self.log.append("settle")


class LoggingFake(FakeOpenAITransport):
    def __init__(self, log: list[str]) -> None:
        super().__init__()
        self.log = log

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.log.append("send")
        return await super().handle_async_request(request)


async def test_every_provider_path_reserves_before_sending_and_settles() -> None:
    """Embeddings, plain chat, tool calling and json_schema output all go
    out through the gate: each send has a reservation before it and a
    settle after it. (The app never asks a provider to stream.)"""
    log: list[str] = []
    llm = build_clients(
        resolve_provider({"LLM_PROVIDER": "fake"}),
        gate=OrderGate(log),
        daily=MemoryDailyCounter(),
        inner=LoggingFake(log),
    )

    @tool
    def search_documents(query: str) -> str:
        """Search."""
        return query

    paths: dict[str, Callable[[], Awaitable[object]]] = {
        "embed": lambda: llm.embed(["a"]),
        "chat": lambda: llm.chat_model().ainvoke([HumanMessage("hi")]),
        "tools": lambda: (
            llm.chat_model().bind_tools([search_documents]).ainvoke([HumanMessage("hi")])
        ),
        "json_schema": lambda: (
            llm.chat_model()
            .with_structured_output(QuoteDraft, method="json_schema", strict=True, include_raw=True)
            .ainvoke([HumanMessage("Draft a quote for Acme Robotics: UX audit")])
        ),
    }
    for name, call in paths.items():
        log.clear()
        await call()
        assert log == ["reserve", "send", "settle"], (name, log)
    await llm.aclose()


def test_only_the_llm_clients_module_builds_a_provider_client() -> None:
    """Nothing in app/ may reach a provider around the gated transport."""
    root = Path(__file__).resolve().parent.parent / "app"
    pattern = re.compile(r"AsyncOpenAI\(|\bOpenAI\(|ChatOpenAI\(|OpenAIEmbeddings|init_chat_model")
    offenders = [
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if pattern.search(path.read_text()) and path.name != "clients.py"
    ]
    assert offenders == []
