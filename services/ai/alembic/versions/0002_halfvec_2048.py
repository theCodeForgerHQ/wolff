"""Embeddings become halfvec(2048) for NIM's nemotron-3-embed-1b.

The model serves 2048 dimensions only, and pgvector's HNSW index takes
`vector` up to 2000 dimensions, `halfvec` up to 4000. Vectors from the old
model (1536) cannot be compared with the new ones, so the chunks and their
ingest state are dropped; the next ai.sweep runs re-embed every source.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-23
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _retype(column_type: str, ops: str) -> None:
    op.execute("DROP INDEX ai.ix_document_chunks_embedding")
    op.execute("DELETE FROM ai.document_chunks")
    op.execute("DELETE FROM ai.ingest_state")
    op.execute(f"ALTER TABLE ai.document_chunks ALTER COLUMN embedding TYPE {column_type}")
    op.execute(
        "CREATE INDEX ix_document_chunks_embedding ON ai.document_chunks "
        f"USING hnsw (embedding {ops})"
    )


def upgrade() -> None:
    _retype("halfvec(2048)", "halfvec_cosine_ops")


def downgrade() -> None:
    _retype("vector(1536)", "vector_cosine_ops")
