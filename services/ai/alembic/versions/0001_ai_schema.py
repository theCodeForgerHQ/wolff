"""The ai schema's tables.

Revision ID: 0001
Revises:
Create Date: 2026-08-09 21:26:13.793165
"""

from collections.abc import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("prompt_version", sa.Text(), nullable=True),
        sa.Column("input", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("output", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("tokens", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(precision=10, scale=6), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('quote_draft', 'chat', 'mcp')", name=op.f("ck_agent_runs_kind")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_runs")),
        schema="ai",
    )
    op.create_index(
        "ix_agent_runs_workspace_created",
        "agent_runs",
        ["workspace_id", "created_at"],
        unique=False,
        schema="ai",
    )
    op.create_table(
        "chat_sessions",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_sessions")),
        schema="ai",
    )
    op.create_index(
        "ix_chat_sessions_workspace_user",
        "chat_sessions",
        ["workspace_id", "user_id"],
        unique=False,
        schema="ai",
    )
    op.create_table(
        "document_chunks",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_id", sa.Text(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("embedding", pgvector.sqlalchemy.vector.VECTOR(dim=1536), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source_type IN ('quote', 'invoice', 'contract', 'client_note')",
            name=op.f("ck_document_chunks_source_type"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_chunks")),
        sa.UniqueConstraint(
            "source_type",
            "source_id",
            "chunk_index",
            name=op.f("uq_document_chunks_source_type_source_id_chunk_index"),
        ),
        schema="ai",
    )
    op.create_index(
        "ix_document_chunks_embedding",
        "document_chunks",
        ["embedding"],
        unique=False,
        schema="ai",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.create_index(
        "ix_document_chunks_workspace_source",
        "document_chunks",
        ["workspace_id", "source_type", "source_id"],
        unique=False,
        schema="ai",
    )
    op.create_table(
        "eval_runs",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("git_sha", sa.Text(), nullable=True),
        sa.Column("dataset_version", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("metrics", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_eval_runs")),
        schema="ai",
    )
    op.create_table(
        "ingest_state",
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_id", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("source_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("source_type", "source_id", name=op.f("pk_ingest_state")),
        schema="ai",
    )
    op.create_index(
        op.f("ix_ingest_state_workspace_id"),
        "ingest_state",
        ["workspace_id"],
        unique=False,
        schema="ai",
    )
    op.create_table(
        "report_snapshots",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(length=50), nullable=False),
        sa.Column("period", sa.String(length=20), nullable=False),
        sa.Column("s3_key", sa.Text(), nullable=False),
        sa.Column("summary", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_report_snapshots")),
        sa.UniqueConstraint(
            "workspace_id",
            "kind",
            "period",
            name=op.f("uq_report_snapshots_workspace_id_kind_period"),
        ),
        schema="ai",
    )
    op.create_table(
        "usage_daily",
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("tokens_in", sa.Integer(), nullable=False),
        sa.Column("tokens_out", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(precision=10, scale=6), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "day", name=op.f("pk_usage_daily")),
        schema="ai",
    )
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("tool_calls", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("citations", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("tokens_in", sa.Integer(), nullable=False),
        sa.Column("tokens_out", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(precision=10, scale=6), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["ai.chat_sessions.id"],
            name=op.f("fk_chat_messages_session_id_chat_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_messages")),
        schema="ai",
    )
    op.create_index(
        op.f("ix_chat_messages_session_id"),
        "chat_messages",
        ["session_id"],
        unique=False,
        schema="ai",
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_chat_messages_session_id"), table_name="chat_messages", schema="ai")
    op.drop_table("chat_messages", schema="ai")
    op.drop_table("usage_daily", schema="ai")
    op.drop_table("report_snapshots", schema="ai")
    op.drop_index(op.f("ix_ingest_state_workspace_id"), table_name="ingest_state", schema="ai")
    op.drop_table("ingest_state", schema="ai")
    op.drop_table("eval_runs", schema="ai")
    op.drop_index("ix_document_chunks_workspace_source", table_name="document_chunks", schema="ai")
    op.drop_index(
        "ix_document_chunks_embedding",
        table_name="document_chunks",
        schema="ai",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.drop_table("document_chunks", schema="ai")
    op.drop_index("ix_chat_sessions_workspace_user", table_name="chat_sessions", schema="ai")
    op.drop_table("chat_sessions", schema="ai")
    op.drop_index("ix_agent_runs_workspace_created", table_name="agent_runs", schema="ai")
    op.drop_table("agent_runs", schema="ai")
