"""`pytest -m eval`: the eval set against a demo-seeded database
(AI_EVAL_DATABASE_URL, the ai_service login), with the offline model.
It asserts the design's thresholds; a live provider run is `make`-free:
LLM_PROVIDER=gemini uv run python -m evals.runner."""

from __future__ import annotations

import os

import pytest

from evals.runner import THRESHOLDS, run

URL = os.environ.get("AI_EVAL_DATABASE_URL", "")
pytestmark = [
    pytest.mark.eval,
    pytest.mark.skipif(not URL, reason="AI_EVAL_DATABASE_URL is not set (demo-seeded database)"),
]


async def test_thresholds_on_the_recorded_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "fake")
    report = await run(URL, write_file=False)
    metrics = report["metrics"]
    assert report["failures"] == [], report["failures"]
    assert metrics["recall_at_6"] >= THRESHOLDS["recall_at_6"]
    assert metrics["schema_valid_rate"] == 1.0
    assert metrics["isolation_leaks"] == 0
    assert metrics["items"] == {"rag": 40, "sql": 20, "drafts": 14, "isolation": 10}
