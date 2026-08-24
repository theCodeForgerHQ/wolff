"""The eval runner's own behaviour, without a database or a model."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

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

    async def oracle(*_: object) -> list[runner.Check]:
        return [[[{"entity": "INV-1"}]]]

    async def ask(*_: object) -> tuple[str, list[dict[str, object]], float, bool]:
        return "INV-1 is overdue [1]", [cite], 12.0, False

    monkeypatch.setattr(runner, "oracle", oracle)
    monkeypatch.setattr(runner, "ask", ask)
    world = runner.World("k", "n", "u", {}, {"NL-SECRET"}, {})

    record = await runner.sql_item(None, world, None, {"question": "q", "oracle": "overdue"})  # type: ignore[arg-type]

    assert record["answer"] == "INV-1 is overdue [1]"
    assert record["citations"] == [cite]
    assert record["expect"] == [[[{"entity": "INV-1"}]]]
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
        None,
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


async def test_an_isolation_chat_that_times_out_is_not_a_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def ask(*_: object) -> tuple[str, list[dict[str, object]], float, bool]:
        return "", [], 60000.0, True

    monkeypatch.setattr(runner, "ask", ask)
    world = runner.World("k", "n", "u", {}, {"INV-NL-001"}, {})

    record = await runner.isolation_item(None, world, None, {"question": "Show INV-NL-001"})  # type: ignore[arg-type]

    assert (record["timed_out"], record["refused"]) == (True, None)


def test_timeouts_are_reported_apart_and_left_out_of_the_rates() -> None:
    """A timeout proves neither a valid schema nor a refusal."""
    records: list[dict[str, Any]] = [
        {"kind": "draft", "schema_valid": True, "timed_out": False},
        {"kind": "draft", "schema_valid": None, "timed_out": True},
        {"kind": "isolation", "refused": True, "timed_out": False},
        {"kind": "isolation", "refused": False, "timed_out": False},
        {"kind": "isolation", "refused": None, "timed_out": True},
        {"kind": "rag", "timed_out": True},
    ]

    assert runner.rate(records, "draft", "schema_valid") == 1.0
    assert runner.rate(records, "isolation", "refused") == 0.5
    assert runner.rate([records[1]], "draft", "schema_valid") is None
    assert runner.timeouts(records) == {"rag": 1, "sql": 0, "draft": 1, "isolation": 1}


def test_an_unmeasured_schema_rate_fails_the_gate() -> None:
    metrics = {"recall_at_6": 1.0, "schema_valid_rate": None, "isolation_leaks": 0}

    assert runner.failures(metrics) == ["schema-valid not measured (every draft timed out)"]


def test_a_checkpoint_is_only_resumed_by_the_same_code_and_models() -> None:
    """Records made by another commit, chat model or fallback must not be
    mixed into a run that reports this one's sha and models."""
    from app.settings import load_settings

    base = {"LLM_PROVIDER": "nvidia", "NVIDIA_API_KEY": "k", "AI_DATABASE_URL": "postgresql://x"}
    one = load_settings(base)
    path = runner.checkpoint_path(one, "abc1234")

    assert runner.checkpoint_path(load_settings(base), "abc1234") == path
    assert runner.checkpoint_path(one, "def5678") != path
    other_model = load_settings({**base, "AI_CHAT_MODEL": "other"})
    assert runner.checkpoint_path(other_model, "abc1234") != path
    with_fallback = load_settings({**base, "LLM_FALLBACK": "groq", "GROQ_API_KEY": "g"})
    assert runner.checkpoint_path(with_fallback, "abc1234") != path


def test_amounts_match_by_value_whatever_the_currency_format() -> None:
    """The model writes INR 2,18,093.82, \u20b9218,093.82 or 218093.82; the
    view says 218093.82. All are the same value."""
    money = [{"number": "218093.82"}]

    for answer in ("INR 2,18,093.82", "\u20b9218,093.82 due", "total: 218093.82", "218,093.820"):
        assert runner.sql_correct(answer, [[money]]), answer
    assert not runner.sql_correct("INR 218,093.81", [[money]])
    assert not runner.sql_correct("INR 1,218,093.82", [[money]])
    assert runner.sql_correct("| 5 %  | 296,215.00 |", [[[{"number": "5"}, {"number": "296215"}]]])


def test_entities_match_ignoring_case_spacing_and_punctuation() -> None:
    check = [[{"entity": "Moore - Bauch"}]]

    assert runner.sql_correct("**Moore\u2011Bauch** owes most", [check])
    assert runner.sql_correct("moore bauch", [check])
    assert not runner.sql_correct("Moore Group", [check])


def test_any_alternative_of_a_check_is_enough_and_every_check_is_needed() -> None:
    """'How much is outstanding?' may be answered per bucket or as totals."""
    by_bucket = [{"number": "100"}, {"number": "200"}]
    totals = [{"number": "300"}]
    checks = [[by_bucket, totals], [[{"entity": "INV-KS-001"}]]]

    assert runner.sql_correct("Total INR 300.00; oldest INV-KS-001", checks)
    assert runner.sql_correct("0-30: 100, 31-60: 200 (INV-KS-001)", checks)
    assert not runner.sql_correct("0-30: 100 (INV-KS-001)", checks)
    assert not runner.sql_correct("Total INR 300.00", checks)


def test_a_stored_ageing_answer_rescores_by_value() -> None:
    """The NIM run's ageing answers were right but scored wrong because
    the oracle wanted the view's raw 'bucket_0_30' tokens."""
    answer = (
        "**INR**\n- Current: \u20b9218,093.82 (5 invoices)\n- 0\u201130 days: \u20b9455,260.66\n"
        "- 31\u201160 days: \u20b9156,552.16\n- 61\u201190 days: \u20b973,928.26\n"
        "**USD**\n- 61\u201190 days: $8,175.50"
    )
    buckets = [
        {"number": v} for v in ("218093.82", "455260.66", "156552.16", "73928.26", "8175.50")
    ]
    totals = [{"number": "903834.90"}, {"number": "8175.50"}]

    assert runner.sql_correct(answer, [[buckets, totals]])
