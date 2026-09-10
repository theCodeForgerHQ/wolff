"""Agent errors, kept apart so importing them does not load LangChain."""

from __future__ import annotations


class DraftError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
