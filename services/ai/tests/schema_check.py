"""Compares mapped tables with a reflected database."""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import Table
from sqlalchemy.engine.reflection import Inspector
from sqlalchemy.types import TypeEngine


def _python_type(type_: TypeEngine[object]) -> type | None:
    try:
        return type_.python_type
    except NotImplementedError:
        return None


def compatible(mapped: TypeEngine[object], reflected: TypeEngine[object]) -> bool:
    """Same Python type. Enums and varchar/text all read as ``str``."""
    left, right = _python_type(mapped), _python_type(reflected)
    if left is None or right is None:
        return type(mapped).__name__ == type(reflected).__name__
    return left is right


def schema_problems(inspector: Inspector, tables: Iterable[Table]) -> list[str]:
    """One line per mapped column that is missing or has another type."""
    problems: list[str] = []
    for table in tables:
        schema = table.schema or "public"
        names = set(inspector.get_table_names(schema)) | set(inspector.get_view_names(schema))
        if table.name not in names:
            problems.append(f"{schema}.{table.name}: table or view missing")
            continue
        actual = {col["name"]: col["type"] for col in inspector.get_columns(table.name, schema)}
        for column in table.columns:
            found = actual.get(column.name)
            if found is None:
                problems.append(f"{schema}.{table.name}.{column.name}: column missing")
            elif not compatible(column.type, found):
                problems.append(
                    f"{schema}.{table.name}.{column.name}: "
                    f"mapped {column.type.compile()}, database has {found}"
                )
    return problems
