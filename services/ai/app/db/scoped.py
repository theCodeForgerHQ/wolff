"""The only way the service builds a query on workspace data.

``scoped(Model, workspace_id)`` is ``select(Model)`` already filtered to the
workspace and, where the table has ``deleted_at``, to live rows. The
workspace always comes from the authenticated caller, never from a
request body or tool argument.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.orm import InstrumentedAttribute


def _column(model: type[Any], name: str) -> InstrumentedAttribute[Any] | None:
    column = getattr(model, name, None)
    return column if isinstance(column, InstrumentedAttribute) else None


def workspace_filter(model: type[Any], workspace_id: str) -> list[Any]:
    """WHERE clauses that keep ``model`` inside the workspace."""
    if not workspace_id:
        raise ValueError("a workspace is required")
    column = _column(model, "workspace_id")
    if column is None:
        raise TypeError(f"{model.__name__} has no workspace_id; scope it through its parent")
    clauses: list[Any] = [column == workspace_id]
    deleted = _column(model, "deleted_at")
    if deleted is not None:
        clauses.append(deleted.is_(None))
    return clauses


def scoped[M](model: type[M], workspace_id: str) -> Select[M]:
    return select(model).where(*workspace_filter(model, workspace_id))
