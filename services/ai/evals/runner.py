"""Eval runner.

    AI_EVAL_DATABASE_URL=postgresql://ai_service:...@.../demo uv run python -m evals.runner

Runs the dataset in evals/dataset against a demo-seeded database as
Kaveri Studio, with whatever LLM_PROVIDER is set (``fake`` for the
recorded run; ``nvidia`` or ``openai`` for a live run; leave
LLM_FALLBACK unset so every answer comes from the model under test). It
indexes both demo workspaces, then measures:

- retrieval recall@6: the expected document is among the retriever's 6;
- citation precision: cited documents that are expected ones;
- answer correctness: expected strings in the answer (RAG and SQL; the
  SQL expectations come from a pandas oracle over the report views);
- schema-valid rate: drafts whose structured output validated;
- GST inputs exact: drafted rate-card lines sent for pricing with the
  card's SAC code and GST rate (GST itself is priced by apps/api, which
  this runner replaces with a recording stand-in, so it never writes);
- client grounding: valid briefs drafted for the right client, and
  briefs naming an unknown or another workspace's client refused;
- isolation leaks: Northlight data in any answer or citation (must be 0);
- p95 latency and cost of the run.

Results go to ai.eval_runs (one row per provider, R30) and to a JSON file.
Exit code 1 when a threshold fails: recall >= 0.85, schema-valid 1.0,
leaks 0.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from functools import partial
from pathlib import Path
from typing import Any

import httpx2
import pandas as pd
from sqlalchemy import text

from app.agent.api_client import ApiClient
from app.agent.chat import run_chat
from app.agent.quote_agent import DraftError, draft_quote
from app.auth import Caller
from app.budget import metered
from app.db.models import EvalRun
from app.rag.ingest import ingest
from app.rag.retriever import WorkspaceRetriever
from app.services import Services, build_services
from app.settings import Settings, load_settings

DATASET = Path(__file__).parent / "dataset"
RESULTS = Path(__file__).parent / "results"
THRESHOLDS = {"recall_at_6": 0.85, "schema_valid_rate": 1.0, "isolation_leaks": 0}
KAVERI, NORTHLIGHT = "kaveri-studio", "northlight-design"
EVAL_SECRET = "eval-" + "0" * 59


def load(name: str) -> list[dict[str, Any]]:
    lines = (DATASET / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def dataset_version() -> str:
    digest = hashlib.sha256()
    for path in sorted(DATASET.glob("*.jsonl")):
        digest.update(path.name.encode() + path.read_bytes())
    return digest.hexdigest()[:12]


class RecordingApi:
    """apps/api stand-in: records what would be sent, writes nothing."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        self.calls.append((request.url.path, body))
        if request.url.path.endswith("/quotes/draft"):
            data: dict[str, Any] = {"quoteId": "eval-draft", "quoteNumber": "EVAL"}
        else:
            data = {"invoice": {}, "lines": []}
        return httpx2.Response(200, json={"success": True, "data": data})


@dataclass
class World:
    kaveri: str
    northlight: str
    user: str
    ids: dict[tuple[str, str], str]
    northlight_markers: set[str]
    rate_cards: dict[str, dict[str, Any]]


async def discover(svc: Services) -> World:
    async with svc.sessions() as s:

        async def one(sql: str, **p: Any) -> Any:
            return (await s.execute(text(sql), p)).scalar_one()

        async def pairs(sql: str, **p: Any) -> list[Any]:
            return list((await s.execute(text(sql), p)).all())

        kaveri = await one("SELECT id FROM workspaces WHERE slug = :s", s=KAVERI)
        northlight = await one("SELECT id FROM workspaces WHERE slug = :s", s=NORTHLIGHT)
        user = await one("SELECT owner_id FROM workspaces WHERE id = :w", w=kaveri)
        ids: dict[tuple[str, str], str] = {}
        for number, id_ in await pairs(
            "SELECT quote_number, id FROM quotes WHERE workspace_id = :w", w=kaveri
        ):
            ids[("quote", number)] = id_
        for number, id_ in await pairs(
            "SELECT invoice_number, id FROM invoices WHERE workspace_id = :w", w=kaveri
        ):
            ids[("invoice", number)] = id_
        for name, id_ in await pairs(
            "SELECT c.name, ci.id FROM contract_instances ci JOIN clients c ON c.id = ci.client_id "
            "WHERE ci.workspace_id = :w",
            w=kaveri,
        ):
            ids[("contract", name)] = id_
        for name, id_ in await pairs(
            "SELECT name, id FROM clients WHERE workspace_id = :w", w=kaveri
        ):
            ids[("client_note", name)] = id_
            ids[("client", name)] = id_
        markers = {northlight, "INV-NL-001", "NL-CONFIDENTIAL-ROYALTY", "7% royalty"}
        for (value,) in await pairs(
            "SELECT id FROM clients WHERE workspace_id = :w UNION ALL SELECT name FROM clients "
            "WHERE workspace_id = :w UNION ALL SELECT id FROM invoices WHERE workspace_id = :w "
            "UNION ALL SELECT invoice_number FROM invoices WHERE workspace_id = :w "
            "UNION ALL SELECT id FROM contract_instances WHERE workspace_id = :w",
            w=northlight,
        ):
            markers.add(value)
        for (total,) in await pairs(
            "SELECT DISTINCT total FROM invoices WHERE workspace_id = :w", w=northlight
        ):
            markers |= amount_markers(total)
        cards = {
            r.name: {"id": r.id, "hsn": r.hsn_sac, "gst": float(r.gst_rate)}
            for r in await pairs(
                "SELECT id, name, hsn_sac, gst_rate FROM rate_cards WHERE workspace_id = :w",
                w=kaveri,
            )
        }
    return World(kaveri, northlight, user, ids, markers, cards)


async def index_everything(svc: Services, world: World) -> int:
    count = 0
    async with svc.sessions() as s:
        sources = (
            await s.execute(
                text(
                    "SELECT 'quote', id, workspace_id FROM quotes WHERE workspace_id IN (:a, :b) "
                    "UNION ALL SELECT 'invoice', id, workspace_id FROM invoices WHERE workspace_id IN (:a, :b) "
                    "UNION ALL SELECT 'contract', id, workspace_id FROM contract_instances "
                    "WHERE workspace_id IN (:a, :b) UNION ALL SELECT 'client_note', id, workspace_id "
                    "FROM clients WHERE workspace_id IN (:a, :b) AND notes IS NOT NULL"
                ),
                {"a": world.kaveri, "b": world.northlight},
            )
        ).all()
    for row in sources:
        kind, source, ws = str(row[0]), str(row[1]), str(row[2])
        with metered(ws):
            async with svc.sessions() as s:
                await ingest(
                    s,
                    workspace_id=ws,
                    source_type=kind,
                    source_id=source,
                    embed=svc.llm.embed,
                    embedding_model=svc.settings.provider.embed_model,
                )
        count += 1
    return count


async def oracle(svc: Services, world: World, name: str) -> list[str]:
    """Expected strings for a SQL question, from the views with pandas."""
    async with svc.sessions() as s:

        async def frame(sql: str) -> pd.DataFrame:
            result = await s.execute(text(sql), {"w": world.kaveri})
            return pd.DataFrame(result.mappings().all())

        ageing = await frame(
            "SELECT v.invoice_number, v.days_overdue, v.amount_due, v.bucket, c.name AS client "
            "FROM v_receivables_ageing v JOIN clients c ON c.id = v.client_id "
            "WHERE v.workspace_id = :w"
        )
        if name == "overdue":
            overdue = ageing[ageing["days_overdue"] > 0].sort_values(
                "days_overdue", ascending=False
            )
            return list(overdue["invoice_number"].head(3))
        if name == "top_debtor":
            owed = ageing.groupby("client")["amount_due"].sum().sort_values(ascending=False)
            return [str(owed.index[0])]
        if name == "ageing":
            return sorted(set(ageing["bucket"])) if "bucket" in ageing else []
        if name == "gst":
            gst = await frame("SELECT gst_rate FROM v_gst_outward_supplies WHERE workspace_id = :w")
            return [f'"gst_rate": {float(r)}' for r in sorted(set(gst["gst_rate"]))][:1]
        if name == "leads":
            leads = await frame(
                "SELECT name FROM leads WHERE workspace_id = :w AND deleted_at IS NULL "
                "ORDER BY created_at DESC LIMIT 1"
            )
            return [str(leads["name"].iloc[0])]
        if name == "deals":
            deals = await frame(
                "SELECT title FROM deals WHERE workspace_id = :w AND deleted_at IS NULL "
                "ORDER BY updated_at DESC LIMIT 1"
            )
            return [str(deals["title"].iloc[0])]
    raise ValueError(name)


async def ask(
    svc: Services, caller: Caller, question: str
) -> tuple[str, list[dict[str, Any]], float, bool]:
    """The answer, its citations, the latency and whether the chat hit its
    wall clock. A timed-out chat scores as an empty answer, so one slow
    reply costs one item instead of aborting the run."""
    started = time.monotonic()
    tokens: list[str] = []
    citations: list[dict[str, Any]] = []
    try:
        async for event in run_chat(svc, caller, question):
            if event.event == "token":
                tokens.append(str(event.data["text"]))
            elif event.event == "citation":
                citations.append(event.data)
    except TimeoutError:
        return "", [], (time.monotonic() - started) * 1000, True
    return "".join(tokens), citations, (time.monotonic() - started) * 1000, False


# Models write non-breaking hyphens (INV\u2011KS\u2011003) and thin or
# no-break spaces (INR\u202f87,951.76). Compared as plain ASCII, a right
# answer scores wrong and a leaked id slips past the leak check.
_TYPOGRAPHY = str.maketrans(
    {c: "-" for c in "\u2010\u2011\u2012\u2013\u2014\u2212"}
    | {c: " " for c in "\u00a0\u2007\u2009\u202f"}
)


def normalise(value: str) -> str:
    return value.translate(_TYPOGRAPHY)


def contains(answer: str, expected: str, *, ignore_case: bool = False) -> bool:
    answer, expected = normalise(answer), normalise(expected)
    if ignore_case:
        answer, expected = answer.lower(), expected.lower()
    return expected in answer


def _mentions(text_: str, marker: str) -> bool:
    """``marker`` as a whole token: INV-NL-001 is not in INV-NL-0012, and
    2,000.00 is not in 12,000.00."""
    return re.search(rf"(?<![\w.,]){re.escape(marker)}(?![\w]|[.,]\d)", text_) is not None


def amount_markers(value: object) -> set[str]:
    """The ways a model writes an amount: 2,000.00, 2000.00, and 2,000 for
    whole amounts of four digits or more."""
    amount = Decimal(str(value))
    out = {f"{amount:,.2f}", f"{amount:.2f}"}
    if amount == amount.to_integral_value() and abs(amount) >= 1000:
        out.add(f"{amount:,.0f}")
    return out


def leaked(world: World, answer: str = "", *, context: object = (), asked: str = "") -> list[str]:
    """Northlight markers in an answer and its context (citations, retrieved
    chunks, a draft). The answer may repeat a marker the user typed as a
    whole token ("I couldn't find INV-NL-001"); the context may not, and no
    other Northlight value may appear anywhere."""
    said = normalise(answer)
    rest = normalise(json.dumps(context, default=str, ensure_ascii=False))
    typed = normalise(asked)
    found = set()
    for marker in filter(None, world.northlight_markers):
        m = normalise(marker)
        if _mentions(rest, m) or (_mentions(said, m) and not _mentions(typed, m)):
            found.add(marker)
    return sorted(found)


async def spent_today(svc: Services, world: World) -> Decimal:
    async with svc.sessions() as s:
        value = await s.scalar(
            text(
                "SELECT COALESCE(SUM(cost_usd), 0) FROM ai.usage_daily "
                "WHERE workspace_id IN (:a, :b) AND day = (now() AT TIME ZONE 'utc')::date"
            ),
            {"a": world.kaveri, "b": world.northlight},
        )
    return Decimal(str(value))


class Checkpoint:
    """Finished items of a run, one JSON line each, so a live run that dies
    (an outage, a quota) resumes where it stopped instead of asking the
    provider again. ``path=None`` keeps them in memory only."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.records: dict[str, dict[str, Any]] = {}
        if path is not None and path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue  # the line being written when the process died
                self.records[entry["key"]] = entry["record"]

    def get(self, key: str) -> dict[str, Any] | None:
        return self.records.get(key)

    def put(self, key: str, record: dict[str, Any]) -> None:
        self.records[key] = record
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"key": key, "record": record}, default=str) + "\n")

    async def item(
        self, key: str, compute: Callable[[], Awaitable[dict[str, Any]]]
    ) -> dict[str, Any]:
        record = self.get(key)
        if record is None:
            record = await compute()
            self.put(key, record)
        return record

    def discard(self) -> None:
        if self.path is not None:
            self.path.unlink(missing_ok=True)


async def rag_item(
    svc: Services, world: World, caller: Caller, item: dict[str, Any]
) -> dict[str, Any]:
    wanted = {
        world.ids[(src["type"], src.get("number") or src["client"])] for src in item["sources"]
    }
    with metered(world.kaveri):
        docs = await WorkspaceRetriever(
            sessions=svc.sessions,
            workspace_id=world.kaveri,
            embed=svc.llm.embed_queries,
            embedding_model=svc.settings.provider.embed_model,
        ).search(item["question"])
    answer, citations, ms, timed_out = await ask(svc, caller, item["question"])
    return {
        "kind": "rag",
        "q": item["question"],
        "hit": bool(wanted & {d.metadata["source_id"] for d in docs}),
        "correct": all(contains(answer, e, ignore_case=True) for e in item["expect"]),
        "cited": len(citations),
        "cited_good": sum(c["source_id"] in wanted for c in citations),
        "answer": answer,
        "citations": citations,
        "retrieved": [d.metadata["source_id"] for d in docs],
        "leaks": leaked(
            world,
            answer,
            context=[citations, [d.page_content for d in docs]],
            asked=item["question"],
        ),
        "ms": ms,
        "timed_out": timed_out,
    }


async def sql_item(
    svc: Services, world: World, caller: Caller, item: dict[str, Any]
) -> dict[str, Any]:
    expect = await oracle(svc, world, item["oracle"])
    answer, citations, ms, timed_out = await ask(svc, caller, item["question"])
    return {
        "kind": "sql",
        "q": item["question"],
        "expect": expect,
        "answer": answer,
        "citations": citations,
        "correct": all(contains(answer, e) for e in expect),
        "leaks": leaked(world, answer, context=citations, asked=item["question"]),
        "ms": ms,
        "timed_out": timed_out,
    }


async def draft_item(
    svc: Services, api: RecordingApi, world: World, caller: Caller, item: dict[str, Any]
) -> dict[str, Any]:
    api.calls.clear()
    started = time.monotonic()
    try:
        result = await draft_quote(svc, caller, item["brief"])
        outcome, draft = "drafted", result.draft
    except DraftError as exc:
        outcome, draft = exc.code, None
    except TimeoutError:
        # Scored as an ungrounded draft; counted in chat_timeouts.
        outcome, draft = "timeout", None
    ms = (time.monotonic() - started) * 1000
    grounded = gst_exact = gst_lines = 0
    if item.get("refuse"):
        grounded = int(outcome == "unknown_client")
    elif draft is not None:
        grounded = int(draft.client_id == world.ids.get(("client", item["client"])))
        sent: dict[str, Any] = next(
            (b for p, b in api.calls if p.endswith("/gst/compute")), {"lines": []}
        )
        for line, priced in zip(draft.line_items, sent["lines"], strict=False):
            card = world.rate_cards.get(line.name)
            if line.source == "rate_card" and card:
                gst_lines += 1
                gst_exact += (
                    priced.get("hsnSac") == card["hsn"] and priced["gstRate"] == card["gst"]
                )
    return {
        "kind": "draft",
        "brief": item["brief"],
        "outcome": outcome,
        "draft": draft.model_dump() if draft else None,
        # A timeout says nothing about the schema: None, left out of the rate.
        "schema_valid": None if outcome == "timeout" else outcome != "invalid_output",
        "grounded": grounded,
        "gst_exact": gst_exact,
        "gst_lines": gst_lines,
        "leaks": leaked(
            world, outcome, context=draft.model_dump() if draft else None, asked=item["brief"]
        ),
        "ms": ms,
        "timed_out": outcome == "timeout",
    }


async def isolation_item(
    svc: Services, world: World, caller: Caller, item: dict[str, Any]
) -> dict[str, Any]:
    if item["question"].startswith("Draft a quote"):
        try:
            await draft_quote(svc, caller, item["question"])
            outcome = "drafted"
        except DraftError as exc:
            outcome = exc.code
        except TimeoutError:
            outcome = "timeout"
        found = leaked(world, outcome, asked=item["question"])
        return {
            "kind": "isolation",
            "q": item["question"],
            "leaks": found,
            "refused": None if outcome == "timeout" else outcome == "unknown_client",
            "ms": None,
            "timed_out": outcome == "timeout",
        }
    answer, citations, ms, timed_out = await ask(svc, caller, item["question"])
    found = leaked(world, answer, context=citations, asked=item["question"])
    return {
        "kind": "isolation",
        "q": item["question"],
        "answer": answer,
        "citations": citations,
        "leaks": found,
        # An empty answer after a timeout is not a refusal.
        "refused": None if timed_out else not found,
        "ms": ms,
        "timed_out": timed_out,
    }


KINDS = ("rag", "sql", "draft", "isolation")


def rate(records: list[dict[str, Any]], kind: str, field_: str) -> float | None:
    """Share of ``kind`` records where ``field_`` holds, over the records
    that measured it (``None`` marks a timeout); None if none did."""
    measured = [r[field_] for r in records if r["kind"] == kind and r.get(field_) is not None]
    return round(sum(map(bool, measured)) / len(measured), 4) if measured else None


def timeouts(records: list[dict[str, Any]]) -> dict[str, int]:
    return {k: sum(bool(r["timed_out"]) for r in records if r["kind"] == k) for k in KINDS}


async def evaluate(
    svc: Services, api: RecordingApi, checkpoint: Checkpoint | None = None
) -> dict[str, Any]:
    cp = checkpoint or Checkpoint(None)
    world = await discover(svc)
    spent_before = await spent_today(svc, world)
    spent_earlier = Decimal(str((cp.get("_cost") or {}).get("usd", "0")))

    async def index() -> dict[str, Any]:
        return {"count": await index_everything(svc, world)}

    indexed = (await cp.item("_indexed", index))["count"]
    caller = Caller(
        issuer="web",
        workspace_id=world.kaveri,
        user_id=world.user,
        scopes=frozenset({"ai:use", "quotes:write"}),
    )
    rag, sql, drafts, isolation = load("rag"), load("sql"), load("drafts"), load("isolation")
    jobs: list[tuple[str, Callable[[], Awaitable[dict[str, Any]]]]] = []
    jobs += [(f"rag:{i}", partial(rag_item, svc, world, caller, it)) for i, it in enumerate(rag)]
    jobs += [(f"sql:{i}", partial(sql_item, svc, world, caller, it)) for i, it in enumerate(sql)]
    jobs += [
        (f"draft:{i}", partial(draft_item, svc, api, world, caller, it))
        for i, it in enumerate(drafts)
    ]
    jobs += [
        (f"isolation:{i}", partial(isolation_item, svc, world, caller, it))
        for i, it in enumerate(isolation)
    ]
    records: list[dict[str, Any]] = []
    for key, compute in jobs:
        records.append(await cp.item(key, compute))
        spent = spent_earlier + await spent_today(svc, world) - spent_before
        cp.put("_cost", {"usd": str(spent)})

    def of(kind: str) -> list[dict[str, Any]]:
        return [r for r in records if r["kind"] == kind]

    def total(kind: str, field_: str) -> int:
        return sum(int(r[field_]) for r in of(kind))

    leaks = [m for r in records for m in r["leaks"]]
    cited = total("rag", "cited")
    gst_lines = total("draft", "gst_lines")
    latencies = sorted(float(r["ms"]) for r in records if r["ms"] is not None)
    cost = spent_earlier + await spent_today(svc, world) - spent_before
    metrics = {
        "provider": svc.settings.provider.name,
        "chat_model": svc.settings.provider.chat_model,
        "embed_model": svc.settings.provider.embed_model,
        "documents_indexed": indexed,
        "items": {
            "rag": len(rag),
            "sql": len(sql),
            "drafts": len(drafts),
            "isolation": len(isolation),
        },
        "recall_at_6": round(total("rag", "hit") / len(rag), 4),
        "citation_precision": round(total("rag", "cited_good") / cited, 4) if cited else None,
        "answer_correctness_rag": round(total("rag", "correct") / len(rag), 4),
        "answer_correctness_sql": round(total("sql", "correct") / len(sql), 4),
        "schema_valid_rate": rate(records, "draft", "schema_valid"),
        "gst_inputs_exact": round(total("draft", "gst_exact") / gst_lines, 4)
        if gst_lines
        else None,
        "client_grounding": round(total("draft", "grounded") / len(drafts), 4),
        "isolation_leaks": len(leaks),
        "isolation_refusal_rate": rate(records, "isolation", "refused"),
        "chat_timeouts": sum(int(r["timed_out"]) for r in records),
        "timeouts": timeouts(records),
        "p95_latency_ms": round(latencies[int(0.95 * (len(latencies) - 1))], 1),
        # The budget gate prices the offline model like gpt-4o-mini.
        "cost_usd_run": str(cost),
    }
    details = [
        {k: v for k, v in r.items() if k not in {"ms", "cited", "cited_good"}} for r in records
    ]
    return {"metrics": metrics, "leaks": sorted(set(leaks)), "details": details}


def failures(metrics: dict[str, Any]) -> list[str]:
    out = []
    if metrics["recall_at_6"] < THRESHOLDS["recall_at_6"]:
        out.append(f"recall@6 {metrics['recall_at_6']} < {THRESHOLDS['recall_at_6']}")
    if metrics["schema_valid_rate"] is None:
        out.append("schema-valid not measured (every draft timed out)")
    elif metrics["schema_valid_rate"] < THRESHOLDS["schema_valid_rate"]:
        out.append(f"schema-valid {metrics['schema_valid_rate']} < 1.0")
    if metrics["isolation_leaks"] > THRESHOLDS["isolation_leaks"]:
        out.append(f"isolation leaks {metrics['isolation_leaks']} > 0")
    return out


def git_sha() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def checkpoint_path(settings: Settings, sha: str | None) -> Path:
    """Where a run's checkpoint lives. The name fingerprints everything the
    records depend on (dataset, commit, provider, models, fallback), so a
    run only ever resumes records made by the same code and models."""
    provider, fallback = settings.provider, settings.fallback
    parts = [
        dataset_version(),
        sha or "no-git",
        provider.name,
        provider.chat_model,
        provider.embed_model,
        f"{fallback.name}:{fallback.chat_model}" if fallback else "no-fallback",
    ]
    digest = hashlib.sha256("\0".join(parts).encode()).hexdigest()[:12]
    return RESULTS / f".checkpoint-{provider.name}-{digest}.jsonl"


async def run(url: str, write_file: bool = True) -> dict[str, Any]:
    env = dict(os.environ)
    settings = load_settings(
        {**env, "AI_DATABASE_URL": url, "AI_DAILY_BUDGET_USD": env.get("AI_DAILY_BUDGET_USD", "5")}
    )
    api = RecordingApi()
    client = ApiClient(
        "http://api.eval",
        EVAL_SECRET,
        httpx2.AsyncClient(transport=httpx2.MockTransport(api.handler)),
    )
    svc = build_services(settings, api=client)
    sha = git_sha()
    checkpoint = Checkpoint(checkpoint_path(settings, sha) if write_file else None)
    try:
        report = await evaluate(svc, api, checkpoint)
        report["git_sha"] = sha
        report["dataset_version"] = dataset_version()
        report["created_at"] = datetime.now(UTC).isoformat(timespec="seconds")
        report["failures"] = failures(report["metrics"])
        async with svc.sessions() as s, s.begin():
            s.add(
                EvalRun(
                    git_sha=report["git_sha"],
                    dataset_version=report["dataset_version"],
                    provider=settings.provider.name,
                    metrics=report["metrics"],
                )
            )
    finally:
        await svc.aclose()
    checkpoint.discard()
    if write_file:
        RESULTS.mkdir(exist_ok=True)
        path = RESULTS / f"{settings.provider.name}-{report['created_at'][:10]}.json"
        path.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
        report["file"] = str(path)
    return report


def main() -> int:
    report = asyncio.run(run(os.environ["AI_EVAL_DATABASE_URL"]))
    print(json.dumps(report["metrics"], indent=2))
    for failure in report["failures"]:
        print("FAIL:", failure, file=sys.stderr)
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
