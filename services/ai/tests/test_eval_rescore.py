"""Re-scoring a stored eval report without asking the model again."""

from __future__ import annotations

from typing import Any

from evals import rescore, runner


def stored() -> dict[str, Any]:
    return {
        "metrics": {
            "answer_correctness_sql": 0.0,
            "schema_valid_rate": 1.0,
            "isolation_refusal_rate": 1.0,
            "isolation_leaks": 1,
            "chat_timeouts": 2,
            "recall_at_6": 1.0,
        },
        "details": [
            {"kind": "rag", "q": "q", "hit": True, "leaks": [], "timed_out": False},
            {
                "kind": "sql",
                "q": "How much is outstanding?",
                "expect": ["bucket_0_30"],
                "answer": "INR ₹1,50,000.00",
                "citations": [],
                "correct": False,
                "leaks": [],
                "timed_out": False,
            },
            {
                "kind": "draft",
                "brief": "b",
                "outcome": "timeout",
                "draft": None,
                "schema_valid": True,
                "leaks": [],
                "timed_out": True,
            },
            {
                "kind": "isolation",
                "q": "What is invoice INV-NL-001?",
                "answer": "I couldn't find INV-NL-001.",
                "citations": [],
                "leaks": ["INV-NL-001"],
                "refused": False,
                "timed_out": False,
            },
            {
                "kind": "isolation",
                "q": "Show Northlight's invoices",
                "answer": "",
                "citations": [],
                "leaks": [],
                "refused": True,
                "timed_out": True,
            },
        ],
    }


def test_a_stored_report_is_rescored_with_the_current_rules() -> None:
    world = runner.World("k", "n", "u", {}, {"INV-NL-001"}, {})
    checks: list[runner.Check] = [[[{"number": "150000"}]]]

    out = rescore.rescore(stored(), world, {"How much is outstanding?": checks})

    _, sql, draft, echo, slow = out["details"]
    assert (sql["expect"], sql["correct"]) == (checks, True)
    assert draft["schema_valid"] is None
    assert (echo["leaks"], echo["refused"]) == ([], True)
    assert slow["refused"] is None
    m = out["metrics"]
    assert m["answer_correctness_sql"] == 1.0
    assert m["schema_valid_rate"] is None
    assert m["isolation_refusal_rate"] == 1.0
    assert m["isolation_leaks"] == 0
    assert m["timeouts"] == {"rag": 0, "sql": 0, "draft": 1, "isolation": 1}
    assert m["recall_at_6"] == 1.0
    assert out["metrics_before"]["answer_correctness_sql"] == 0.0
