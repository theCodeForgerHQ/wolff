"""Re-score a stored eval report with the current scoring rules.

    AI_EVAL_DATABASE_URL=postgresql://ai_service:...@.../demo \\
        uv run python -m evals.rescore evals/results/nvidia-2026-08-23.json

Nothing is sent to a model: the answers, citations and outcomes stored in
the report are scored again. SQL expectations are recomputed from the
views (the same database the run used; ``days_overdue`` and the ageing
buckets move with the date, so re-score on the run's UTC day). Leaks are
re-checked on what the report stored; RAG records keep no chunk text, so
their retrieved chunks are not re-checked. Writes ``<report>.rescored.json``
next to the input and leaves the input as it was.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.services import build_services
from app.settings import load_settings
from evals.runner import (
    Check,
    World,
    discover,
    git_sha,
    leaked,
    load,
    oracle,
    rate,
    sql_correct,
    timeouts,
)


def _rescore_record(record: dict[str, Any], world: World, expect: dict[str, list[Check]]) -> None:
    kind = record["kind"]
    if kind == "sql":
        record["expect"] = expect[record["q"]]
        record["correct"] = sql_correct(record["answer"], record["expect"])
        record["leaks"] = leaked(
            world, record["answer"], context=record["citations"], asked=record["q"]
        )
    elif kind == "rag" and "answer" in record:  # early records kept only verdicts
        record["leaks"] = leaked(
            world, record["answer"], context=record["citations"], asked=record["q"]
        )
    elif kind == "draft":
        if record["timed_out"]:
            record["schema_valid"] = None
        record["leaks"] = leaked(
            world, record["outcome"], context=record["draft"], asked=record["brief"]
        )
    elif kind == "isolation" and "answer" in record:
        record["leaks"] = leaked(
            world, record["answer"], context=record["citations"], asked=record["q"]
        )
        record["refused"] = None if record["timed_out"] else not record["leaks"]
    elif kind == "isolation" and record["timed_out"]:  # a draft-shaped item
        record["refused"] = None


def rescore(report: dict[str, Any], world: World, expect: dict[str, list[Check]]) -> dict[str, Any]:
    """A copy of ``report`` scored with the current rules. ``expect`` maps
    each SQL question to its oracle checks."""
    out = copy.deepcopy(report)
    records: list[dict[str, Any]] = out["details"]
    for record in records:
        _rescore_record(record, world, expect)
    sql = [r for r in records if r["kind"] == "sql"]
    out["metrics_before"] = report["metrics"]
    out["metrics"] = {
        **report["metrics"],
        "answer_correctness_sql": round(sum(r["correct"] for r in sql) / len(sql), 4)
        if sql
        else None,
        "schema_valid_rate": rate(records, "draft", "schema_valid"),
        "isolation_refusal_rate": rate(records, "isolation", "refused"),
        "isolation_leaks": sum(len(r["leaks"]) for r in records),
        "timeouts": timeouts(records),
    }
    out["leaks"] = sorted({m for r in records for m in r["leaks"]})
    return out


async def main_async(url: str, path: Path) -> Path:
    report = json.loads(path.read_text(encoding="utf-8"))
    svc = build_services(
        load_settings({**os.environ, "AI_DATABASE_URL": url, "LLM_PROVIDER": "fake"})
    )
    try:
        world = await discover(svc)
        by_name: dict[str, list[Check]] = {}
        expect: dict[str, list[Check]] = {}
        for item in load("sql"):
            name = item["oracle"]
            if name not in by_name:
                by_name[name] = await oracle(svc, world, name)
            expect[item["question"]] = by_name[name]
    finally:
        await svc.aclose()
    out = rescore(report, world, expect)
    out["rescored_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    out["rescored_git_sha"] = git_sha()
    target = path.with_suffix(".rescored.json")
    target.write_text(json.dumps(out, indent=2, default=str) + "\n", encoding="utf-8")
    return target


def main() -> int:
    target = asyncio.run(main_async(os.environ["AI_EVAL_DATABASE_URL"], Path(sys.argv[1])))
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
