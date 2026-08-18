import pytest

from app.llm.providers import ProviderError, resolve_provider


def test_gemini_is_the_default_and_uses_the_openai_compatible_endpoint() -> None:
    p = resolve_provider({})
    assert p.name == "gemini"
    assert p.base_url == "https://generativelanguage.googleapis.com/v1beta/openai/"
    assert p.api_key_env == "GEMINI_API_KEY"
    assert p.embed_model == "gemini-embedding-001"


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
