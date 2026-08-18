"""Indexing one document.

Load (workspace-scoped) -> split 800/100 -> skip when every chunk's hash
and the embedding model are unchanged -> embed -> replace the source's
chunks in one transaction -> record ``ai.ingest_state``. A source that no
longer exists in the workspace has its chunks removed.
"""

from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from langchain_text_splitters import RecursiveCharacterTextSplitter
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DocumentChunk, IngestState
from app.rag.loaders import load_document

CHUNK_SIZE = 800
CHUNK_OVERLAP = 100
#: Demo cap on chunks per workspace.
MAX_CHUNKS_PER_WORKSPACE = 2_000

Embed = Callable[[Sequence[str]], Awaitable[list[list[float]]]]
Outcome = Literal["indexed", "unchanged", "removed", "capped"]

_splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)


@dataclass(frozen=True)
class IngestResult:
    outcome: Outcome
    chunks: int


def split(text: str) -> list[str]:
    return _splitter.split_text(text)


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def _record(
    session: AsyncSession,
    workspace_id: str,
    source_type: str,
    source_id: str,
    status: str,
    source_updated_at: datetime | None,
    error: str | None = None,
) -> None:
    values = {
        "source_type": source_type,
        "source_id": source_id,
        "workspace_id": workspace_id,
        "source_updated_at": source_updated_at,
        "indexed_at": datetime.now(UTC),
        "status": status,
        "error": error,
    }
    statement = insert(IngestState).values(**values)
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=[IngestState.source_type, IngestState.source_id],
            set_={k: v for k, v in values.items() if k not in ("source_type", "source_id")},
            # A source id is never re-used across workspaces; the guard
            # makes sure a crafted id cannot overwrite another's state.
            where=IngestState.workspace_id == workspace_id,
        )
    )


async def ingest(
    session: AsyncSession,
    *,
    workspace_id: str,
    source_type: str,
    source_id: str,
    embed: Embed,
    embedding_model: str,
) -> IngestResult:
    """Index one source for ``workspace_id``. Commits."""
    document = await load_document(session, workspace_id, source_type, source_id)
    mine = (
        DocumentChunk.workspace_id == workspace_id,
        DocumentChunk.source_type == source_type,
        DocumentChunk.source_id == source_id,
    )

    if document is None:
        await session.execute(delete(DocumentChunk).where(*mine))
        await _record(session, workspace_id, source_type, source_id, "removed", None)
        await session.commit()
        return IngestResult("removed", 0)

    pieces = split(document.text)
    hashes = [content_hash(p) for p in pieces]
    existing = (
        await session.execute(
            select(DocumentChunk.content_hash, DocumentChunk.embedding_model)
            .where(*mine)
            .order_by(DocumentChunk.chunk_index)
        )
    ).all()
    if [h for h, _ in existing] == hashes and all(m == embedding_model for _, m in existing):
        await _record(session, workspace_id, source_type, source_id, "indexed", document.updated_at)
        await session.commit()
        return IngestResult("unchanged", len(pieces))

    others = await session.scalar(
        select(func.count())
        .select_from(DocumentChunk)
        .where(DocumentChunk.workspace_id == workspace_id)
        .where((DocumentChunk.source_type != source_type) | (DocumentChunk.source_id != source_id))
    )
    if (others or 0) + len(pieces) > MAX_CHUNKS_PER_WORKSPACE:
        await _record(
            session,
            workspace_id,
            source_type,
            source_id,
            "capped",
            document.updated_at,
            f"workspace chunk limit {MAX_CHUNKS_PER_WORKSPACE} reached",
        )
        await session.commit()
        return IngestResult("capped", 0)

    vectors = await embed(pieces)
    await session.execute(delete(DocumentChunk).where(*mine))
    session.add_all(
        DocumentChunk(
            workspace_id=workspace_id,
            source_type=source_type,
            source_id=source_id,
            chunk_index=index,
            content=piece,
            metadata_={"source_type": source_type, "source_id": source_id, **document.metadata},
            content_hash=hashes[index],
            embedding=vectors[index],
            embedding_model=embedding_model,
        )
        for index, piece in enumerate(pieces)
    )
    await _record(session, workspace_id, source_type, source_id, "indexed", document.updated_at)
    await session.commit()
    return IngestResult("indexed", len(pieces))
