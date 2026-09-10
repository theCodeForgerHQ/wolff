from decimal import Decimal

import pytest

from app.llm.providers import ProviderError, resolve_fallback, resolve_provider


def test_nvidia_nim_is_the_default() -> None:
    p = resolve_provider({})
    assert p.name == "nvidia"
    assert p.base_url == "https://integrate.api.nvidia.com/v1"
    assert p.api_key_env == "NVIDIA_API_KEY"
    assert p.chat_model == "nvidia/nemotron-3.5-super-vl-120b-a12b"
    assert p.embed_model == "nvidia/nemotron-3-embed-1b"
    # The model only serves 2048 dimensions and is asymmetric (query/passage).
    assert (p.embed_dimensions, p.embed_input_type) == (2048, True)
    assert p.rpm == 40


def test_groq_is_chat_only_so_it_can_only_be_the_fallback() -> None:
    with pytest.raises(ProviderError, match="LLM_FALLBACK"):
        resolve_provider({"LLM_PROVIDER": "groq"})
    f = resolve_fallback({"LLM_PROVIDER": "nvidia", "LLM_FALLBACK": "groq"})
    assert f is not None
    assert (f.name, f.base_url, f.api_key_env) == (
        "groq",
        "https://api.groq.com/openai/v1",
        "GROQ_API_KEY",
    )
    assert f.chat_model == "openai/gpt-oss-120b"
    # Groq's published free limits for openai/gpt-oss-120b.
    assert (f.rpm, f.rpd, f.tpm) == (30, 1_000, 8_000)


def test_no_fallback_unless_configured() -> None:
    assert resolve_fallback({}) is None
    assert resolve_fallback({"LLM_FALLBACK": " "}) is None


def test_fallback_model_override_and_checks() -> None:
    env = {"LLM_FALLBACK": "groq", "AI_FALLBACK_CHAT_MODEL": "qwen/qwen3.8-27b"}
    assert resolve_fallback(env).chat_model == "qwen/qwen3.8-27b"  # type: ignore[union-attr]
    with pytest.raises(ProviderError, match="same"):
        resolve_fallback({"LLM_PROVIDER": "nvidia", "LLM_FALLBACK": "nvidia"})
    with pytest.raises(ProviderError, match="LLM_FALLBACK"):
        resolve_fallback({"LLM_FALLBACK": "claude"})
    with pytest.raises(ProviderError, match="ALLOWLIST"):
        resolve_fallback({**env, "AI_MODEL_ALLOWLIST": "openai/gpt-oss-120b"})


def test_prices_are_looked_up_by_model() -> None:
    p = resolve_provider({"LLM_PROVIDER": "fake"})
    assert p.price(p.chat_model) == (p.price_in, p.price_out)
    assert p.price("anything") == (p.price_in, p.price_out)
    assert isinstance(p.price_in, Decimal)


@pytest.mark.parametrize(
    "env",
    [{"LLM_PROVIDER": "gemini"}, {"LLM_PROVIDER": "nvidia", "LLM_FALLBACK": "gemini"}],
)
def test_gemini_is_refused_for_chat(env: dict[str, str]) -> None:
    """The chat agent always calls tools, and Gemini 3 tool calls fail with
    400 "Function call is missing a thought signature" through the OpenAI
    client: refuse it at start rather than fail every chat turn."""
    with pytest.raises(ProviderError, match="thought signature"):
        resolve_provider(env)
        resolve_fallback(env)


def test_openai_profile() -> None:
    p = resolve_provider({"LLM_PROVIDER": "openai"})
    assert p.base_url == "https://api.openai.com/v1"
    assert p.embed_model == "text-embedding-3-small"


def test_models_are_overridable() -> None:
    p = resolve_provider({"LLM_PROVIDER": "openai", "AI_CHAT_MODEL": "x", "AI_EMBED_MODEL": "y"})
    assert (p.chat_model, p.embed_model) == ("x", "y")


def test_github_models_fails_fast_as_retired() -> None:
    with pytest.raises(ProviderError, match="retired"):
        resolve_provider({"LLM_PROVIDER": "github-models"})


def test_unknown_provider_is_refused() -> None:
    with pytest.raises(ProviderError, match="LLM_PROVIDER"):
        resolve_provider({"LLM_PROVIDER": "claude"})


def test_fake_provider_is_refused_in_production() -> None:
    assert resolve_provider({"LLM_PROVIDER": "fake"}).name == "fake"
    with pytest.raises(ProviderError, match="production"):
        resolve_provider({"LLM_PROVIDER": "fake", "ENVIRONMENT": "production"})


def test_a_model_outside_the_allowlist_is_refused() -> None:
    with pytest.raises(ProviderError, match="ALLOWLIST"):
        resolve_provider(
            {
                "LLM_PROVIDER": "openai",
                "AI_CHAT_MODEL": "gpt-5",
                "AI_MODEL_ALLOWLIST": "gpt-4o-mini,text-embedding-3-small",
            }
        )
