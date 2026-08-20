"""WorkspaceRetriever.

The workspace filter is in the SQL, never applied afterwards: pgvector 0.8
iterative scan (``relaxed_order``) keeps the HNSW index from returning 20
rows of other workspaces and then nothing. Vectors from another embedding
model are never compared. The 20 nearest chunks are re-ranked by cosine
similarity, Postgres full-text rank and recency, and the best 6 kept.
"""

from __future__ import annotations

import math
import re
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any

from langchain_core.callbacks import AsyncCallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from pydantic import ConfigDict
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import DocumentChunk

CANDIDATES = 20
TOP_K = 6
#: Below this cosine similarity a chunk is not evidence.
MIN_SIMILARITY = 0.15
RECENCY_HALF_LIFE_DAYS = 180.0
WEIGHTS = (0.75, 0.15, 0.10)  # similarity, text rank, recency

#: Document numbers such as Q-KS-001, INV/26-27/0001 or CN-0001.
_NUMBER = re.compile(r"\b[A-Z]{1,5}(?:[-/][A-Z0-9]{1,6}){1,3}\b")

Embed = Callable[[Sequence[str]], Awaitable[list[list[float]]]]


def _recency(updated: datetime, now: datetime) -> float:
    age_days = max((now - updated).total_seconds() / 86_400, 0.0)
    return math.pow(0.5, age_days / RECENCY_HALF_LIFE_DAYS)


class WorkspaceRetriever(BaseRetriever):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    sessions: async_sessionmaker[AsyncSession]
    workspace_id: str
    embed: Embed
    embedding_model: str
    source_types: list[str] | None = None

    def _get_relevant_documents(self, query: str, **_: Any) -> list[Document]:
        raise NotImplementedError("WorkspaceRetriever is async only")

    async def _aget_relevant_documents(
        self, query: str, *, run_manager: AsyncCallbackManagerForRetrieverRun | None = None
    ) -> list[Document]:
        return await self.search(query)

    async def search(self, query: str) -> list[Document]:
        if not self.workspace_id:
            raise ValueError("a workspace is required")
        [vector] = await self.embed([query])
        distance = DocumentChunk.embedding.cosine_distance(vector)
        rank = func.ts_rank(
            func.to_tsvector("english", DocumentChunk.content),
            func.plainto_tsquery("english", query),
        )
        statement = (
            select(DocumentChunk, (1 - distance).label("similarity"), rank.label("rank"))
            .where(
                DocumentChunk.workspace_id == self.workspace_id,
                DocumentChunk.embedding_model == self.embedding_model,
            )
            .order_by(distance)
            .limit(CANDIDATES)
        )
        if self.source_types:
            statement = statement.where(DocumentChunk.source_type.in_(self.source_types))

        numbers = sorted(set(_NUMBER.findall(query)))
        async with self.sessions() as session, session.begin():
            await session.execute(text("SET LOCAL hnsw.ef_search = 64"))
            await session.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
            rows = list((await session.execute(statement)).all())
            if numbers:
                # Exact document numbers are the strongest signal a query can
                # carry, and embeddings blur them: also take the chunks of
                # documents whose number the query names (same filters).
                exact = (
                    statement.order_by(None)
                    .where(DocumentChunk.metadata_["number"].astext.in_(numbers))
                    .order_by(DocumentChunk.chunk_index)
                    .limit(TOP_K)
                )
                seen = {row[0].id for row in rows}
                rows += [
                    row for row in (await session.execute(exact)).all() if row[0].id not in seen
                ]

        now = datetime.now(UTC)
        scored: list[tuple[float, Document]] = []
        for row in rows:
            chunk: DocumentChunk = row[0]
            similarity, text_rank = float(row[1]), float(row[2])
            named = chunk.metadata_.get("number") in numbers
            if similarity < MIN_SIMILARITY and not named:
                continue
            score = (
                WEIGHTS[0] * similarity
                + WEIGHTS[1] * min(text_rank * 10, 1.0)
                + WEIGHTS[2] * _recency(chunk.updated_at, now)
                + (1.0 if named else 0.0)
            )
            scored.append(
                (
                    score,
                    Document(
                        page_content=chunk.content,
                        metadata={
                            **chunk.metadata_,
                            "chunk_id": chunk.id,
                            "source_type": chunk.source_type,
                            "source_id": chunk.source_id,
                            "similarity": round(similarity, 4),
                            "score": round(score, 4),
                        },
                    ),
                )
            )
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [doc for _, doc in scored[:TOP_K]]
