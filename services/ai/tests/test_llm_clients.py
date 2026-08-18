from __future__ import annotations

import math

import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from app.llm.clients import build_clients, fit_dimensions
from app.llm.fake import embed
from app.llm.providers import resolve_provider
from app.llm.transport import MemoryDailyCounter, Usage


class Gate:
    def __init__(self) -> None:
        self.used: list[Usage] = []

    async def before(self, model: str) -> None:
        return None

    async def after(self, usage: Usage) -> None:
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
