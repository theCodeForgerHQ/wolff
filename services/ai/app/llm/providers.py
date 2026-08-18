"""LLM provider profiles.

Every provider is reached through the OpenAI SDK interface. ``gemini`` (the
free tier's OpenAI-compatible endpoint) is the demo default, ``openai`` the
production provider. ``github-models`` was retired on 2026-07-30 and fails
at start. ``fake`` is a deterministic, offline stand-in (app/llm/fake.py)
for tests, the recorded eval run and local E2E; it is refused in
production.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from decimal import Decimal


class ProviderError(ValueError):
    """The provider setting cannot be used; the service must not start."""


@dataclass(frozen=True, slots=True)
class ProviderProfile:
    name: str
    base_url: str
    api_key_env: str
    chat_model: str
    embed_model: str
    rpm: int
    rpd: int
    tpm: int
    max_concurrency: int
    embed_batch: int
    #: USD per 1M input / output tokens, for the budget. Free tiers are
    #: priced at the paid list price so the daily cap still limits volume.
    price_in: Decimal
    price_out: Decimal


_PROFILES: dict[str, ProviderProfile] = {
    "openai": ProviderProfile(
        name="openai",
        base_url="https://api.openai.com/v1",
        api_key_env="OPENAI_API_KEY",
        chat_model="gpt-4o-mini",
        embed_model="text-embedding-3-small",
        rpm=500,
        rpd=10_000,
        tpm=200_000,
        max_concurrency=8,
        embed_batch=100,
        price_in=Decimal("0.15"),
        price_out=Decimal("0.60"),
    ),
    # Free-tier limits and model names are "verify at signup".
    "gemini": ProviderProfile(
        name="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        api_key_env="GEMINI_API_KEY",
        chat_model="gemini-2.5-flash",
        embed_model="gemini-embedding-001",
        rpm=10,
        rpd=250,
        tpm=250_000,
        max_concurrency=2,
        embed_batch=50,
        price_in=Decimal("0.30"),
        price_out=Decimal("2.50"),
    ),
    "fake": ProviderProfile(
        name="fake",
        base_url="http://fake-llm.invalid/v1",
        api_key_env="",
        chat_model="fake-chat",
        embed_model="fake-embed",
        rpm=10_000,
        rpd=1_000_000,
        tpm=10_000_000,
        max_concurrency=8,
        embed_batch=100,
        price_in=Decimal("0.15"),
        price_out=Decimal("0.60"),
    ),
}


def resolve_provider(env: Mapping[str, str]) -> ProviderProfile:
    """Profile for ``LLM_PROVIDER`` with env overrides applied."""
    name = (env.get("LLM_PROVIDER") or "gemini").strip()
    if name == "github-models":
        raise ProviderError(
            "LLM_PROVIDER=github-models: GitHub Models was retired on 2026-07-30; "
            "use gemini or openai"
        )
    profile = _PROFILES.get(name)
    if profile is None:
        raise ProviderError(f"LLM_PROVIDER must be gemini, openai or fake, not {name!r}")
    if name == "fake" and env.get("ENVIRONMENT", "").strip() == "production":
        raise ProviderError("LLM_PROVIDER=fake is for tests and is refused in production")

    chat = (env.get("AI_CHAT_MODEL") or "").strip() or profile.chat_model
    embed = (env.get("AI_EMBED_MODEL") or "").strip() or profile.embed_model
    allow = {m.strip() for m in (env.get("AI_MODEL_ALLOWLIST") or "").split(",") if m.strip()}
    if allow and not {chat, embed} <= allow:
        raise ProviderError(
            f"AI_CHAT_MODEL/AI_EMBED_MODEL not in AI_MODEL_ALLOWLIST: {chat}, {embed}"
        )
    return replace(profile, chat_model=chat, embed_model=embed)
