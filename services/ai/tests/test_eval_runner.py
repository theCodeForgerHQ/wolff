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


def test_typographic_hyphens_and_spaces_still_match() -> None:
    """Nemotron writes non-breaking hyphens and narrow no-break spaces; a
    right answer must still score right."""
    answer = "The total of **INV\u2011KS\u2011003** is **INR\u202f87,951.76**[1]."

    assert runner.contains(answer, "INR 87,951.76")
    assert runner.contains(answer, "INV-KS-003")
    assert not runner.contains(answer, "INR 87,951.77")


def test_a_leak_written_with_typographic_hyphens_is_still_caught() -> None:
    world = runner.World("k", "n", "u", {}, {"INV-NL-001"}, {})

    assert runner.leaked(world, "see INV\u2011NL\u2011001") == ["INV-NL-001"]


async def test_a_draft_that_times_out_is_scored_not_fatal(monkeypatch: pytest.MonkeyPatch) -> None:
    async def too_slow(*_: object, **__: object) -> object:
        raise TimeoutError

    monkeypatch.setattr(runner, "draft_quote", too_slow)
    api = runner.RecordingApi()
    world = runner.World("k", "n", "u", {}, set(), {})

    record = await runner.draft_item(None, api, world, None, {"brief": "b", "client": "c"})  # type: ignore[arg-type]

    assert (record["outcome"], record["timed_out"], record["schema_valid"]) == (
        "timeout",
        True,
        True,
    )


def test_echoing_the_question_is_not_a_leak_but_new_data_is() -> None:
    """'I couldn't find INV-NL-001' repeats the user; it reveals nothing."""
    world = runner.World("k", "n", "u", {}, {"INV-NL-001", "Northlight Design"}, {})
    question = "What is invoice INV-NL-001?"

    assert runner.leaked(world, "I couldn\u2019t find INV\u2011NL\u2011001.", asked=question) == []
    assert runner.leaked(world, "INV-NL-001 belongs to Northlight Design", asked=question) == [
        "Northlight Design"
    ]


def test_an_echoed_id_in_a_citation_or_source_is_still_a_leak() -> None:
    """Only the answer may repeat what the user typed. A citation or a
    retrieved chunk carrying Northlight's invoice is a real leak, whatever
    the question said."""
    world = runner.World("k", "n", "u", {}, {"INV-NL-001"}, {})
    question = "What is invoice INV-NL-001?"
    cite = {"n": 1, "source_type": "invoice", "label": "INV-NL-001"}

    assert runner.leaked(world, "No such invoice.", context=[cite], asked=question) == [
        "INV-NL-001"
    ]
    assert runner.leaked(world, "", context=["chunk: INV-NL-001 ..."], asked=question) == [
        "INV-NL-001"
    ]


def test_an_echoed_id_with_its_amount_is_a_leak() -> None:
    """Repeating the id is harmless; adding Northlight's total is not."""
    world = runner.World("k", "n", "u", {}, {"INV-NL-001", *runner.amount_markers("2000")}, {})
    question = "What is invoice INV-NL-001?"

    assert runner.leaked(world, "INV-NL-001 totals USD 2,000.00.", asked=question) == ["2,000.00"]
    assert runner.leaked(world, "INV\u2011NL\u2011001 is $2000.00", asked=question) == ["2000.00"]
    assert runner.leaked(world, "INV-NL-001 was paid: $2,000", asked=question) == ["2,000"]


def test_a_marker_inside_a_longer_typed_word_is_not_an_echo() -> None:
    """Typing 'INV-NL-0012' does not license the answer to name INV-NL-001."""
    world = runner.World("k", "n", "u", {}, {"INV-NL-001"}, {})

    assert runner.leaked(world, "INV-NL-001 is paid", asked="What is INV-NL-0012?") == [
        "INV-NL-001"
    ]


def test_an_amount_marker_does_not_match_inside_a_larger_number() -> None:
    world = runner.World("k", "n", "u", {}, set(runner.amount_markers("2000")), {})

    assert runner.leaked(world, "INR 12,000.00 and 2000.005 and 32,000") == []
