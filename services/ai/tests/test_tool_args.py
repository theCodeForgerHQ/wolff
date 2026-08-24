"""Tool arguments as models actually send them."""

from __future__ import annotations

import pytest

from app.agent.tools import optional_filter


@pytest.mark.parametrize(
    "sent", [None, "", "  ", "None", "none", "null", "NULL", "all", "any", "*"]
)
def test_a_placeholder_for_no_filter_means_no_filter(sent: str | None) -> None:
    # Nemotron called list_leads(status="None") and reported "no leads".
    assert optional_filter(sent) is None


def test_a_real_filter_is_kept_trimmed() -> None:
    assert optional_filter(" qualified ") == "qualified"
