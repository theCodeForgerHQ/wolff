"""ingest_state.attempts: failed indexing attempts since the last success.

A source whose loading or embedding keeps failing is recorded as
status 'error' and left out of the sweep after a few attempts, instead of
failing every sweep call.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-04
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ingest_state",
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        schema="ai",
    )


def downgrade() -> None:
    op.drop_column("ingest_state", "attempts", schema="ai")
