"""Tables the AI service owns, in the ``ai`` schema.

Alembic (``alembic/``) creates them; nothing else writes here. Ids that
point at Prisma rows (workspace, quote, user, ...) are ``text`` like the
Prisma columns they copy, and have no foreign key into ``public``: the
two schemas migrate independently.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# halfvec: pgvector indexes `vector` up to 2000 dimensions only, halfvec up
# to 4000, and NIM's embedding model serves 2048 (alembic 0002).
EMBEDDING_DIMENSIONS = 2048
SOURCE_TYPES = ("quote", "invoice", "contract", "client_note")
RUN_KINDS = ("quote_draft", "chat", "mcp")


def _uuid() -> str:
    return str(uuid.uuid4())


class AiBase(DeclarativeBase):
    """Base for the ``ai`` schema."""

    metadata = MetaData(
        schema="ai",
        naming_convention={
            "ix": "ix_%(table_name)s_%(column_0_N_name)s",
            "uq": "uq_%(table_name)s_%(column_0_N_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        },
    )


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class DocumentChunk(AiBase):
    """One embedded piece of a workspace document."""

    __tablename__ = "document_chunks"
    __table_args__ = (
        CheckConstraint(
            "source_type IN ('quote', 'invoice', 'contract', 'client_note')", name="source_type"
        ),
        UniqueConstraint("source_type", "source_id", "chunk_index"),
        Index("ix_document_chunks_workspace_source", "workspace_id", "source_type", "source_id"),
        Index(
            "ix_document_chunks_embedding",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "halfvec_cosine_ops"},
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(Text)
    source_type: Mapped[str] = mapped_column(Text)
    source_id: Mapped[str] = mapped_column(Text)
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, default=dict)
    content_hash: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float]] = mapped_column(HALFVEC(EMBEDDING_DIMENSIONS))
    embedding_model: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class IngestState(AiBase):
    """When a source was last indexed, and how that went."""

    __tablename__ = "ingest_state"

    source_type: Mapped[str] = mapped_column(Text, primary_key=True)
    source_id: Mapped[str] = mapped_column(Text, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(Text, index=True)
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    #: Failed attempts since the last success; the sweep gives up at a limit.
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")


class ChatSession(AiBase):
    """A conversation in the assistant panel."""

    __tablename__ = "chat_sessions"
    __table_args__ = (Index("ix_chat_sessions_workspace_user", "workspace_id", "user_id"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(Text)
    user_id: Mapped[str] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class ChatMessage(AiBase):
    """One turn of a conversation."""

    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        Text, ForeignKey("ai.chat_sessions.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text)
    tool_calls: Mapped[list[Any] | None] = mapped_column(JSONB)
    citations: Mapped[list[Any] | None] = mapped_column(JSONB)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 6), default=Decimal(0))
    created_at: Mapped[datetime] = _created()


class AgentRun(AiBase):
    """One run of the chat router, the quote agent or an MCP tool."""

    __tablename__ = "agent_runs"
    __table_args__ = (
        CheckConstraint("kind IN ('quote_draft', 'chat', 'mcp')", name="kind"),
        Index("ix_agent_runs_workspace_created", "workspace_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    prompt_version: Mapped[str | None] = mapped_column(Text)
    input: Mapped[dict[str, Any]] = mapped_column(JSONB)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(Text)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 6), default=Decimal(0))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class UsageDaily(AiBase):
    """Spend per workspace per UTC day, checked against the budget."""

    __tablename__ = "usage_daily"

    workspace_id: Mapped[str] = mapped_column(Text, primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 6), default=Decimal(0))


class EvalRun(AiBase):
    """Metrics of one eval run, one row per provider (R30)."""

    __tablename__ = "eval_runs"

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    git_sha: Mapped[str | None] = mapped_column(Text)
    dataset_version: Mapped[str] = mapped_column(Text)
    provider: Mapped[str] = mapped_column(Text)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _created()


class ReportSnapshot(AiBase):
    """A stored nightly report; one per workspace, kind and period."""

    __tablename__ = "report_snapshots"
    __table_args__ = (UniqueConstraint("workspace_id", "kind", "period"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(50))
    period: Mapped[str] = mapped_column(String(20))
    s3_key: Mapped[str] = mapped_column(Text)
    summary: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _created()
