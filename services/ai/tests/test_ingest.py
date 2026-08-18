from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.models import DocumentChunk, IngestState
from app.db.session import session_factory
from app.llm.fake import embed as fake_embed
from app.rag import ingest as ingest_module
from app.rag.ingest import ingest, split
from app.rag.loaders import html_to_text
from tests.conftest import requires_db
from tests.seed import Seeded


class Embedder:
    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, texts: Sequence[str]) -> list[list[float]]:
        self.calls += 1
        return [fake_embed(t) for t in texts]


async def run(engine: AsyncEngine, ws: str, kind: str, source: str, e: Embedder, model: str = "m"):  # type: ignore[no-untyped-def]
    async with session_factory(engine)() as session:
        return await ingest(
            session,
            workspace_id=ws,
            source_type=kind,
            source_id=source,
            embed=e,
            embedding_model=model,
        )


async def chunks(engine: AsyncEngine, source: str) -> list[DocumentChunk]:
    async with session_factory(engine)() as session:
        return list(
            await session.scalars(select(DocumentChunk).where(DocumentChunk.source_id == source))
        )


def test_split_uses_800_with_overlap() -> None:
    pieces = split(" ".join(f"word{i}" for i in range(400)))
    assert len(pieces) > 1 and all(len(p) <= 800 for p in pieces)
    assert pieces[0][-50:].split()[-1] in pieces[1]


def test_html_to_text() -> None:
    assert html_to_text("<p>a &amp; b</p><p>c</p>") == "a & b\nc"


@requires_db
async def test_indexes_a_quote_with_metadata(migrated: AsyncEngine, ws_a: Seeded) -> None:
    result = await run(migrated, ws_a.workspace_id, "quote", ws_a.quote_id, Embedder())
    assert result.outcome == "indexed"
    rows = await chunks(migrated, ws_a.quote_id)
    assert rows and all(r.workspace_id == ws_a.workspace_id for r in rows)
    assert "Landing page build" in rows[0].content and "Acme Robotics" in rows[0].content
    assert rows[0].metadata_["client_name"] == "Acme Robotics"
    assert rows[0].metadata_["number"] == "Q-A-001"


@requires_db
async def test_unchanged_content_is_not_embedded_again(migrated: AsyncEngine, ws_a: Seeded) -> None:
    await run(migrated, ws_a.workspace_id, "invoice", ws_a.invoice_id, Embedder())
    again = Embedder()
    result = await run(migrated, ws_a.workspace_id, "invoice", ws_a.invoice_id, again)
    assert result.outcome == "unchanged" and again.calls == 0
    other_model = Embedder()
    result = await run(migrated, ws_a.workspace_id, "invoice", ws_a.invoice_id, other_model, "m2")
    assert result.outcome == "indexed" and other_model.calls == 1


@requires_db
async def test_another_workspaces_document_is_not_indexed(
    migrated: AsyncEngine, ws_a: Seeded, ws_b: Seeded
) -> None:
    await run(migrated, ws_b.workspace_id, "contract", ws_b.contract_id, Embedder())
    e = Embedder()
    result = await run(migrated, ws_a.workspace_id, "contract", ws_b.contract_id, e)
    assert result.outcome == "removed" and e.calls == 0
    rows = await chunks(migrated, ws_b.contract_id)
    assert rows and {r.workspace_id for r in rows} == {ws_b.workspace_id}
    async with session_factory(migrated)() as session:
        state = await session.get(IngestState, ("contract", ws_b.contract_id))
    assert state is not None and state.workspace_id == ws_b.workspace_id


@requires_db
async def test_a_deleted_source_loses_its_chunks(
    migrated: AsyncEngine, admin_engine: AsyncEngine, ws_a: Seeded
) -> None:
    await run(migrated, ws_a.workspace_id, "client_note", ws_a.client_id, Embedder())
    assert await chunks(migrated, ws_a.client_id)
    async with admin_engine.begin() as c:
        await c.execute(
            text("UPDATE clients SET notes = NULL WHERE id = :id"), {"id": ws_a.client_id}
        )
    try:
        result = await run(migrated, ws_a.workspace_id, "client_note", ws_a.client_id, Embedder())
        assert result.outcome == "removed"
        assert await chunks(migrated, ws_a.client_id) == []
    finally:
        async with admin_engine.begin() as c:
            await c.execute(
                text(
                    "UPDATE clients SET notes = 'Acme prefers invoices on the first working day "
                    "of the month.' WHERE id = :id"
                ),
                {"id": ws_a.client_id},
            )


@requires_db
async def test_the_workspace_chunk_cap(
    migrated: AsyncEngine, ws_a: Seeded, monkeypatch: object
) -> None:
    import pytest

    mp = pytest.MonkeyPatch()
    mp.setattr(ingest_module, "MAX_CHUNKS_PER_WORKSPACE", 0)
    try:
        e = Embedder()
        result = await run(migrated, ws_a.workspace_id, "quote", ws_a.quote_id, e, "m3")
        assert result.outcome == "capped" and e.calls == 0
    finally:
        mp.undo()
