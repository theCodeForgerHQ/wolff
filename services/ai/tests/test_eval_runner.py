"""The eval runner's own behaviour, without a database or a model."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from evals import runner


async def test_a_chat_that_times_out_is_scored_not_fatal(monkeypatch: pytest.MonkeyPatch) -> None:
    """One slow answer costs one item; it must not abort a live run of 84."""

    async def too_slow(*_: object, **__: object) -> AsyncIterator[object]:
        raise TimeoutError
        yield  # pragma: no cover

    monkeypatch.setattr(runner, "run_chat", too_slow)

    answer, citations, _, timed_out = await runner.ask(None, None, "question")  # type: ignore[arg-type]

    assert (answer, citations, timed_out) == ("", [], True)


async def test_a_resumed_run_reuses_recorded_items(tmp_path: Path) -> None:
    """A live run interrupted by an outage resumes; finished items are not
    asked again (they cost free-tier requests)."""
    path = tmp_path / "checkpoint.jsonl"
    calls: list[str] = []

    async def compute(key: str) -> dict[str, object]:
        calls.append(key)
        return {"correct": True, "key": key}

    first = runner.Checkpoint(path)
    assert await first.item("rag:0", lambda: compute("rag:0")) == {"correct": True, "key": "rag:0"}
    # The process dies while writing the next record.
    with path.open("a", encoding="utf-8") as f:
        f.write('{"key": "rag:1", "rec')

    resumed = runner.Checkpoint(path)
    assert await resumed.item("rag:0", lambda: compute("rag:0")) == {
        "correct": True,
        "key": "rag:0",
    }
    assert await resumed.item("rag:1", lambda: compute("rag:1")) == {
        "correct": True,
        "key": "rag:1",
    }
    assert calls == ["rag:0", "rag:1"]

    resumed.discard()
    assert not path.exists()


async def test_a_record_keeps_the_answer_and_citations(monkeypatch: pytest.MonkeyPatch) -> None:
    """Records are inspected by hand and re-scored without asking the model
    again, so they keep what the model said, not only the verdict."""
    cite = {"n": 1, "source_type": "invoice", "source_id": "i1", "label": "INV-1"}

    async def oracle(*_: object) -> list[str]:
        return ["INV-1"]

    async def ask(*_: object) -> tuple[str, list[dict[str, object]], float, bool]:
        return "INV-1 is overdue [1]", [cite], 12.0, False

    monkeypatch.setattr(runner, "oracle", oracle)
    monkeypatch.setattr(runner, "ask", ask)
    world = runner.World("k", "n", "u", {}, {"NL-SECRET"}, {})

    record = await runner.sql_item(None, world, None, {"question": "q", "oracle": "overdue"})  # type: ignore[arg-type]

    assert record["answer"] == "INV-1 is overdue [1]"
    assert record["citations"] == [cite]
    assert record["expect"] == ["INV-1"]
    assert record["correct"] is True
