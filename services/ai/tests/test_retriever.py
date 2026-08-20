from __future__ import annotations

from collections.abc import Sequence

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db.session import session_factory
from app.llm.fake import embed as fake_embed
from app.rag.ingest import ingest
from app.rag.retriever import WorkspaceRetriever
from tests.conftest import requires_db
from tests.seed import Seeded

MODEL = "fake-embed"


async def embed(texts: Sequence[str]) -> list[list[float]]:
    return [fake_embed(t) for t in texts]


@pytest.fixture
async def indexed(migrated: AsyncEngine, ws_a: Seeded, ws_b: Seeded) -> tuple[Seeded, Seeded]:
    sessions = session_factory(migrated)
    for ws in (ws_a, ws_b):
        for kind, source in (
            ("quote", ws.quote_id),
            ("invoice", ws.overdue_invoice_id),
            ("contract", ws.contract_id),
            ("client_note", ws.client_id),
        ):
            async with sessions() as session:
                await ingest(
                    session,
                    workspace_id=ws.workspace_id,
                    source_type=kind,
                    source_id=source,
                    embed=embed,
                    embedding_model=MODEL,
                )
    return ws_a, ws_b


def retriever(engine: AsyncEngine, ws: Seeded, **kw: object) -> WorkspaceRetriever:
    return WorkspaceRetriever(
        sessions=session_factory(engine),
        workspace_id=ws.workspace_id,
        embed=embed,
        embedding_model=kw.pop("model", MODEL),
        **kw,
    )


@requires_db
async def test_finds_the_relevant_document_with_its_source(
    migrated: AsyncEngine, indexed: tuple[Seeded, Seeded]
) -> None:
    a, _ = indexed
    docs = await retriever(migrated, a).ainvoke("When is payment due on the invoice?")
    assert docs[0].metadata["source_type"] == "contract"
    assert docs[0].metadata["source_id"] == a.contract_id
    assert "15 days" in docs[0].page_content
    assert len(docs) <= 6


@requires_db
async def test_never_returns_another_workspaces_chunks(
    migrated: AsyncEngine, indexed: tuple[Seeded, Seeded]
) -> None:
    a, b = indexed
    b_ids = {b.quote_id, b.overdue_invoice_id, b.contract_id, b.client_id}
    for question in ["Bluefin confidential clause B-ONLY-SECRET penalty", "Mobile app MVP"]:
        docs = await retriever(migrated, a).search(question)
        assert not {d.metadata["source_id"] for d in docs} & b_ids
        assert all("B-ONLY-SECRET" not in d.page_content for d in docs)
    docs = await retriever(migrated, b).search("Bluefin confidential clause B-ONLY-SECRET")
    assert docs and docs[0].metadata["source_id"] == b.contract_id


@requires_db
async def test_filters_by_type_and_by_embedding_model(
    migrated: AsyncEngine, indexed: tuple[Seeded, Seeded]
) -> None:
    a, _ = indexed
    docs = await retriever(migrated, a, source_types=["quote"]).search(
        "website redesign landing page build"
    )
    assert docs and {d.metadata["source_type"] for d in docs} == {"quote"}
    assert await retriever(migrated, a, model="other-model").search("payment") == []


@requires_db
async def test_nothing_relevant_returns_nothing(
    migrated: AsyncEngine, indexed: tuple[Seeded, Seeded]
) -> None:
    a, _ = indexed
    assert await retriever(migrated, a).search("zebra xylophone quantum") == []


@requires_db
async def test_search_endpoint_is_scoped_to_the_token(
    client: object, indexed: tuple[Seeded, Seeded]
) -> None:
    from httpx import AsyncClient

    from tests.conftest import service_token

    assert isinstance(client, AsyncClient)
    a, b = indexed
    token = service_token(a.workspace_id, ["ai:use"])
    r = await client.post(
        "/search",
        json={"query": "Bluefin confidential clause B-ONLY-SECRET"},
        headers={"authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    assert all(d["metadata"]["source_id"] != b.contract_id for d in r.json()["data"])
    no_scope = service_token(a.workspace_id, ["quotes:read"])
    r = await client.post(
        "/search", json={"query": "x"}, headers={"authorization": f"Bearer {no_scope}"}
    )
    assert r.status_code == 403


@requires_db
async def test_a_named_document_number_is_found_in_the_callers_workspace_only(
    migrated: AsyncEngine, indexed: tuple[Seeded, Seeded]
) -> None:
    a, b = indexed
    docs = await retriever(migrated, a).search("What does Q-A-001 include?")
    assert docs[0].metadata["source_id"] == a.quote_id
    assert all(
        d.metadata["source_id"] != a.quote_id
        for d in await retriever(migrated, b).search("What does Q-A-001 include?")
    )
