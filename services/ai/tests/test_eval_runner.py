"""The eval runner's own behaviour, without a database or a model."""

from __future__ import annotations

from collections.abc import AsyncIterator

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
