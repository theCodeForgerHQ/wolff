"""LLM provider profiles (as superseded in docs/phase-5.md).

Every provider is reached through the OpenAI SDK interface. ``nvidia`` (NIM,
build.nvidia.com's free API) is the demo default for chat and embeddings,
with ``groq`` as an optional chat fallback (``LLM_FALLBACK``; Groq serves no
embeddings, so it cannot be the primary). ``gemini`` stays available for
embeddings and plain chat, but its tool calls need Gemini 3 thought
signatures that the LangChain OpenAI client drops. ``openai`` is the
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
    #: Dimensions to ask the embedding model for (stored zero-padded to the
    #: column's width, see app/llm/clients.py). 0: the provider has none.
    embed_dimensions: int = 1536
    #: Asymmetric embedding model: send ``input_type`` query or passage.
    embed_input_type: bool = False

    def price(self, model: str) -> tuple[Decimal, Decimal]:
        """USD per 1M input / output tokens for ``model`` (one price per profile)."""
        del model
        return self.price_in, self.price_out


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
    # Free API of build.nvidia.com. NVIDIA publishes no number for it (no
    # docs page, no rate-limit headers, checked 2026-08-23); 40 requests a
    # minute is the commonly reported per-account limit and is used here as
    # a conservative ceiling. rpd and tpm are our own. Free, so priced
    # nominally (about the paid open-model market rate) to let the daily
    # budget still bound volume. docs/free-tier.md.
    "nvidia": ProviderProfile(
        name="nvidia",
        base_url="https://integrate.api.nvidia.com/v1",
        api_key_env="NVIDIA_API_KEY",
        chat_model="nvidia/nemotron-3-super-120b-a12b",
        embed_model="nvidia/nemotron-3-embed-1b",
        rpm=40,
        rpd=5_000,
        tpm=200_000,
        max_concurrency=2,
        embed_batch=32,
        price_in=Decimal("0.10"),
        price_out=Decimal("0.50"),
        embed_dimensions=2048,
        embed_input_type=True,
    ),
    # Groq free plan, openai/gpt-oss-120b: 30 RPM, 1K RPD, 8K TPM, 200K TPD
    # (console.groq.com/docs/rate-limits, read 2026-08-23; the response
    # headers agree). Chat only. Priced at Groq's paid list price.
    "groq": ProviderProfile(
        name="groq",
        base_url="https://api.groq.com/openai/v1",
        api_key_env="GROQ_API_KEY",
        chat_model="openai/gpt-oss-120b",
        embed_model="",
        rpm=30,
        rpd=1_000,
        tpm=8_000,
        max_concurrency=2,
        embed_batch=0,
        price_in=Decimal("0.15"),
        price_out=Decimal("0.75"),
        embed_dimensions=0,
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
        embed_dimensions=2048,
    ),
}


_NAMES = ", ".join(sorted(_PROFILES))


def _profile(env: Mapping[str, str], variable: str, name: str) -> ProviderProfile:
    if name == "github-models":
        raise ProviderError(
            f"{variable}=github-models: GitHub Models was retired on 2026-07-30; "
            "use nvidia, gemini or openai"
        )
    profile = _PROFILES.get(name)
    if profile is None:
        raise ProviderError(f"{variable} must be one of {_NAMES}, not {name!r}")
    if name == "fake" and env.get("ENVIRONMENT", "").strip() == "production":
        raise ProviderError(f"{variable}=fake is for tests and is refused in production")
    return profile


def _check_allowlist(env: Mapping[str, str], models: set[str], what: str) -> None:
    allow = {m.strip() for m in (env.get("AI_MODEL_ALLOWLIST") or "").split(",") if m.strip()}
    if allow and not models <= allow:
        raise ProviderError(f"{what} not in AI_MODEL_ALLOWLIST: {', '.join(sorted(models))}")


def resolve_provider(env: Mapping[str, str]) -> ProviderProfile:
    """Profile for ``LLM_PROVIDER`` (chat and embeddings) with env overrides."""
    name = (env.get("LLM_PROVIDER") or "nvidia").strip()
    profile = _profile(env, "LLM_PROVIDER", name)
    if not profile.embed_model:
        raise ProviderError(
            f"LLM_PROVIDER={name} serves no embeddings; use it as LLM_FALLBACK for chat"
        )
    chat = (env.get("AI_CHAT_MODEL") or "").strip() or profile.chat_model
    embed = (env.get("AI_EMBED_MODEL") or "").strip() or profile.embed_model
    _check_allowlist(env, {chat, embed}, "AI_CHAT_MODEL/AI_EMBED_MODEL")
    return replace(profile, chat_model=chat, embed_model=embed)


def resolve_fallback(env: Mapping[str, str]) -> ProviderProfile | None:
    """Chat-only fallback for ``LLM_FALLBACK``, or None. Embeddings never fall
    back: vectors of two models cannot be compared."""
    name = (env.get("LLM_FALLBACK") or "").strip()
    if not name:
        return None
    primary = (env.get("LLM_PROVIDER") or "nvidia").strip()
    if name == primary:
        raise ProviderError(f"LLM_FALLBACK={name} is the same provider as LLM_PROVIDER")
    profile = _profile(env, "LLM_FALLBACK", name)
    chat = (env.get("AI_FALLBACK_CHAT_MODEL") or "").strip() or profile.chat_model
    _check_allowlist(env, {chat}, "AI_FALLBACK_CHAT_MODEL")
    return replace(profile, chat_model=chat)
