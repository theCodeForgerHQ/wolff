"""Versioned prompts. Each file starts with a front matter
``version:``; the version recorded in ai.agent_runs is that value plus the
first 8 hex digits of the file's SHA-256, so an unversioned edit is still
visible in the runs."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from functools import cache
from pathlib import Path

_DIR = Path(__file__).parent


@dataclass(frozen=True)
class Prompt:
    name: str
    version: str
    text: str


@cache
def load_prompt(name: str) -> Prompt:
    raw = (_DIR / f"{name}.md").read_text(encoding="utf-8")
    if not raw.startswith("---\n"):
        raise ValueError(f"prompt {name} has no front matter")
    header, body = raw[4:].split("\n---\n", 1)
    fields = dict(line.split(":", 1) for line in header.splitlines() if ":" in line)
    declared = fields.get("version", "").strip()
    if not declared:
        raise ValueError(f"prompt {name} has no version")
    digest = hashlib.sha256(raw.encode()).hexdigest()[:8]
    return Prompt(name=name, version=f"{declared}+{digest}", text=body.strip())
