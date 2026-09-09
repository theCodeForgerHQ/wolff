from __future__ import annotations

import json
import math
import re
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path

import httpx2 as httpx
import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from app.agent.schemas import QuoteDraft
from app.budget import BudgetExceeded
from app.llm.clients import EMBEDDING_DIMENSIONS, build_clients, fit_dimensions
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
    assert len(vectors) == 3 and all(len(v) == EMBEDDING_DIMENSIONS == 2048 for v in vectors)
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


def test_fit_dimensions_zero_pads_a_shorter_vector_keeping_cosine() -> None:
    a, b = [3.0, 4.0, 0.0], [4.0, 3.0, 0.0]
    pa, pb = fit_dimensions(a, 8), fit_dimensions(b, 8)
    assert pa == [0.6, 0.8, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    assert math.isclose(cosine(pa, pb), 24 / 25)
    with pytest.raises(ValueError, match="empty"):
        fit_dimensions([], 8)


class CapturingNim(httpx.AsyncBaseTransport):
    """Answers /embeddings like NIM's nemotron-3-embed-1b (2048 floats)."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, object]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.bodies.append(body)
        data = [
            {"object": "embedding", "index": i, "embedding": [1.0] + [0.0] * 2047}
            for i, _ in enumerate(body["input"])
        ]
        return httpx.Response(
            200, json={"data": data, "usage": {"prompt_tokens": 3}}, request=request
        )


async def test_an_asymmetric_model_gets_query_or_passage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NVIDIA_API_KEY", "test-key")
    inner = CapturingNim()
    llm = build_clients(
        resolve_provider({"LLM_PROVIDER": "nvidia"}),
        gate=Gate(),
        daily=MemoryDailyCounter(),
        inner=inner,
    )
    [passage] = await llm.embed(["Logo redesign for Kaveri Studio"])
    [query] = await llm.embed_queries(["logo redesign"])
    await llm.aclose()

    assert [b["input_type"] for b in inner.bodies] == ["passage", "query"]
    assert all(b["dimensions"] == 2048 for b in inner.bodies)
    assert len(passage) == len(query) == 2048


async def test_a_symmetric_model_gets_no_input_type() -> None:
    log: list[str] = []
    inner = LoggingFake(log)
    captured: list[dict[str, object]] = []
    original = inner.handle_async_request

    async def capture(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return await original(request)

    inner.handle_async_request = capture  # type: ignore[method-assign]
    llm = build_clients(
        resolve_provider({"LLM_PROVIDER": "fake"}),
        gate=Gate(),
        daily=MemoryDailyCounter(),
        inner=inner,
    )
    await llm.embed_queries(["q"])
    await llm.aclose()
    assert "input_type" not in captured[0]
    assert captured[0]["dimensions"] == 2048


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
        "embed_queries": lambda: llm.embed_queries(["a"]),
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


class Down(httpx.AsyncBaseTransport):
    """A provider answering every request with ``status``."""

    def __init__(self, status: int) -> None:
        self.status = status
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return httpx.Response(self.status, json={"error": {"message": "down"}}, request=request)


def with_fallback(primary_inner: httpx.AsyncBaseTransport, gate: object, log: list[str]):  # type: ignore[no-untyped-def]
    fake = resolve_provider({"LLM_PROVIDER": "fake"})
    backup = replace(fake, name="fake-backup", chat_model="fake-backup-chat")
    return build_clients(
        fake,
        gate=gate,  # type: ignore[arg-type]
        daily=MemoryDailyCounter(),
        inner=primary_inner,
        fallback=backup,
        fallback_gate=gate,  # type: ignore[arg-type]
        fallback_inner=LoggingFake(log),
    )


async def test_chat_falls_back_to_the_next_provider_when_the_first_is_down() -> None:
    log: list[str] = []
    down = Down(503)
    llm = with_fallback(down, OrderGate(log), log)

    reply = await llm.run_chat(lambda model: model.ainvoke([HumanMessage("hi")]))

    await llm.aclose()
    assert down.calls == 3  # the transport's own retries, then the fallback
    assert reply.response_metadata["model_name"] == "fake-backup-chat"
    # The fallback's request is reserved and settled like any other.
    assert log[-3:] == ["reserve", "send", "settle"]


async def test_no_fallback_on_a_client_error_or_without_a_fallback() -> None:
    log: list[str] = []
    llm = with_fallback(Down(400), OrderGate(log), log)
    with pytest.raises(Exception, match="400"):
        await llm.run_chat(lambda model: model.ainvoke([HumanMessage("hi")]))
    await llm.aclose()
    assert "send" not in log

    alone = build_clients(
        resolve_provider({"LLM_PROVIDER": "fake"}),
        gate=Gate(),
        daily=MemoryDailyCounter(),
        inner=Down(503),
    )
    with pytest.raises(Exception, match="503"):
        await alone.run_chat(lambda model: model.ainvoke([HumanMessage("hi")]))
    await alone.aclose()


async def test_an_exceeded_budget_never_falls_back() -> None:
    class Broke(Gate):
        async def reserve(self, model: str, tokens_in: int, max_tokens_out: int) -> object:
            raise BudgetExceeded("daily AI budget exceeded")

    log: list[str] = []
    llm = with_fallback(LoggingFake(log), Broke(), log)
    with pytest.raises(BudgetExceeded):
        await llm.run_chat(lambda model: model.ainvoke([HumanMessage("hi")]))
    await llm.aclose()
    assert log == []


def _status_error(code: int) -> BaseException:
    import openai

    request = httpx.Request("POST", "https://llm.example.test/v1/chat/completions")
    return openai.APIStatusError(
        "failed", response=httpx.Response(code, request=request), body=None
    )


@pytest.mark.parametrize("code", [401, 403, 404, 410, 429, 500, 503])
def test_the_provider_failing_falls_back(code: int) -> None:
    """A model the account can no longer use (404 "not found for account",
    410 end of life) or a key it no longer accepts is the provider failing,
    not the request: the fallback must answer instead."""
    from app.llm.clients import is_fallback_error

    assert is_fallback_error(_status_error(code))


@pytest.mark.parametrize("code", [400, 413, 422])
def test_a_bad_request_does_not_fall_back(code: int) -> None:
    from app.llm.clients import is_fallback_error

    assert not is_fallback_error(_status_error(code))
