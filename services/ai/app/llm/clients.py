"""Builds the LLM clients on top of the shared transport."""

from __future__ import annotations

import math
import os
from collections.abc import Sequence
from dataclasses import dataclass

import httpx2 as httpx
from langchain_openai import ChatOpenAI
from openai import AsyncOpenAI
from pydantic import SecretStr

from app.llm.fake import FakeOpenAITransport
from app.llm.providers import ProviderProfile
from app.llm.transport import DailyCounter, RateLimitedTransport, UsageGate

EMBEDDING_DIMENSIONS = 1536
DEFAULT_MAX_TOKENS = 1024
REQUEST_TIMEOUT_SECONDS = 30.0


def fit_dimensions(vector: Sequence[float], dimensions: int = EMBEDDING_DIMENSIONS) -> list[float]:
    """Truncate and L2-normalise (Matryoshka models such as gemini-embedding-001
    support truncation), for an endpoint that ignores ``dimensions``."""
    if len(vector) < dimensions:
        raise ValueError(f"embedding has {len(vector)} dimensions, need {dimensions}")
    cut = list(vector[:dimensions])
    norm = math.sqrt(sum(v * v for v in cut)) or 1.0
    return [v / norm for v in cut]


@dataclass(frozen=True)
class LlmClients:
    profile: ProviderProfile
    openai: AsyncOpenAI
    http: httpx.AsyncClient
    max_tokens: int

    def chat_model(self, **kwargs: object) -> ChatOpenAI:
        """A LangChain chat model on the shared transport, SDK retries off."""
        return ChatOpenAI(
            model=self.profile.chat_model,
            base_url=self.profile.base_url,
            api_key=SecretStr(self._key()),
            http_async_client=self.http,
            max_retries=0,
            max_tokens=self.max_tokens,
            temperature=0,
            **kwargs,
        )

    def _key(self) -> str:
        if not self.profile.api_key_env:
            return "fake"
        key = os.environ.get(self.profile.api_key_env, "")
        if not key:
            raise RuntimeError(f"{self.profile.api_key_env} is not set")
        return key

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embeddings in input order, 1536 floats each, in provider-sized batches."""
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.profile.embed_batch):
            batch = list(texts[start : start + self.profile.embed_batch])
            response = await self.openai.embeddings.create(
                model=self.profile.embed_model, input=batch, dimensions=EMBEDDING_DIMENSIONS
            )
            ordered = sorted(response.data, key=lambda item: item.index)
            vectors.extend(fit_dimensions(item.embedding) for item in ordered)
        return vectors

    async def aclose(self) -> None:
        await self.http.aclose()


def build_clients(
    profile: ProviderProfile,
    *,
    gate: UsageGate,
    daily: DailyCounter,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    inner: httpx.AsyncBaseTransport | None = None,
) -> LlmClients:
    if inner is None:
        inner = FakeOpenAITransport() if profile.name == "fake" else httpx.AsyncHTTPTransport()
    transport = RateLimitedTransport(
        inner,
        provider=profile.name,
        rpm=profile.rpm,
        tpm=profile.tpm,
        rpd=profile.rpd,
        max_concurrency=profile.max_concurrency,
        allowed_models=frozenset({profile.chat_model, profile.embed_model}),
        gate=gate,
        daily=daily,
    )
    http = httpx.AsyncClient(transport=transport, timeout=REQUEST_TIMEOUT_SECONDS)
    key = "fake" if not profile.api_key_env else os.environ.get(profile.api_key_env, "missing")
    client = AsyncOpenAI(base_url=profile.base_url, api_key=key, http_client=http, max_retries=0)
    return LlmClients(profile=profile, openai=client, http=http, max_tokens=max_tokens)
