"""What Alembic may see: only objects in the ``ai`` schema.

Autogenerate and ``alembic check`` must never propose touching Prisma's
``public`` tables.
"""

from __future__ import annotations


def _schema(obj: object, type_: str) -> str | None:
    owner = obj if type_ == "table" else getattr(obj, "table", None)
    schema = getattr(owner, "schema", None)
    return schema if isinstance(schema, str) else None


def include_object(
    obj: object, name: str | None, type_: str, reflected: bool, compare_to: object | None
) -> bool:
    """Alembic ``include_object`` hook."""
    return _schema(obj, type_) == "ai"


def include_name(name: str | None, type_: str, parent_names: dict[str, str | None]) -> bool:
    """Alembic ``include_name`` hook: reflect no schema but ``ai``."""
    if type_ == "schema":
        return name == "ai"
    return True
