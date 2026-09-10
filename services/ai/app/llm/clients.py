"""Builds the LLM clients on top of the shared transport."""

from __future__ import annotations

import math
import os
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeVar

import httpx2 as httpx
from openai import APIConnectionError, APIStatusError, AsyncOpenAI
from pydantic import SecretStr

from app.budget import BudgetExceeded
from app.llm.fake import FakeOpenAITransport
from app.llm.providers import ProviderProfile
from app.llm.transport import DailyCounter, LlmUnavailable, RateLimitedTransport, UsageGate

if TYPE_CHECKING:
    from langchain_openai import ChatOpenAI

T = TypeVar("T")

#: Width of the stored vectors (ai.document_chunks.embedding, halfvec):
#: NIM's nemotron-3-embed-1b serves 2048 only. Models with fewer dimensions
#: are zero-padded, which leaves cosine similarity between them unchanged.
EMBEDDING_DIMENSIONS = 2048
DEFAULT_MAX_TOKENS = 1024
REQUEST_TIMEOUT_SECONDS = 30.0


def fit_dimensions(vector: Sequence[float], dimensions: int = EMBEDDING_DIMENSIONS) -> list[float]:
    """L2-normalised and exactly ``dimensions`` long: truncated when longer
    (Matryoshka models such as gemini-embedding-001 support it, for an
    endpoint that ignores ``dimensions``), zero-padded when shorter."""
    if not vector:
        raise ValueError("embedding is empty")
    cut = list(vector[:dimensions])
    norm = math.sqrt(sum(v * v for v in cut)) or 1.0
    return [v / norm for v in cut] + [0.0] * (dimensions - len(cut))


#: Statuses that mean the provider can't serve this account any more.
PROVIDER_GONE = frozenset({401, 403, 404, 410})


def is_fallback_error(exc: BaseException) -> bool:
    """The provider, not the request, failed: rate limited or out of daily
    requests, a 5xx, unreachable, or no longer serving us (a key it rejects,
    401/403; a model "not found for account", 404; a retired model, 410).
    A spent budget is not one of them: the budget is per workspace, shared by
    every provider."""
    if isinstance(exc, BudgetExceeded):
        return False
    if isinstance(exc, LlmUnavailable | APIConnectionError):
        return True
    if isinstance(exc, APIStatusError):
        return exc.status_code in PROVIDER_GONE or exc.status_code == 429 or exc.status_code >= 500
    return isinstance(exc, httpx.TimeoutException | httpx.NetworkError)


@dataclass(frozen=True)
class LlmClients:
    profile: ProviderProfile
    openai: AsyncOpenAI
    http: httpx.AsyncClient
    max_tokens: int
    #: Chat-only fallback (LLM_FALLBACK), on its own gated transport.
    fallback: LlmClients | None = None

    def chat_models(self, **kwargs: Any) -> list[ChatOpenAI]:
        """The chat model, then the fallback's, in the order to try them."""
        chain = [self.chat_model(**kwargs)]
        if self.fallback is not None:
            chain.append(self.fallback.chat_model(**kwargs))
        return chain

    def chat_attempts(
        self, *, fallback_max_tokens: int | None = None
    ) -> list[tuple[ProviderProfile, ChatOpenAI]]:
        """The chat model, then the fallback's, each with the profile it runs
        on. ``fallback_max_tokens`` lowers the fallback's reply budget (never
        raises it above AI_MAX_TOKENS)."""
        attempts = [(self.profile, self.chat_model())]
        if self.fallback is not None:
            limit = min(fallback_max_tokens or self.max_tokens, self.max_tokens)
            attempts.append((self.fallback.profile, self.fallback.chat_model(max_tokens=limit)))
        return attempts

    async def run_chat(self, run: Callable[[ChatOpenAI], Awaitable[T]], **kwargs: object) -> T:
        """``run`` with the chat model, again with the fallback's if the
        provider failed (is_fallback_error). Other errors propagate."""
        models = self.chat_models(**kwargs)
        for index, model in enumerate(models):
            try:
                return await run(model)
            except Exception as exc:
                if index == len(models) - 1 or not is_fallback_error(exc):
                    raise
        raise AssertionError("unreachable")

    def chat_model(self, *, max_tokens: int | None = None, **kwargs: Any) -> ChatOpenAI:
        """A LangChain chat model on the shared transport, SDK retries off."""
        # Imported here: LangChain costs about a second of CPU on a cold start,
        # and health checks and search never build a chat model.
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=self.profile.chat_model,
            base_url=self.profile.base_url,
            api_key=SecretStr(self._key()),
            http_async_client=self.http,
            max_retries=0,
            max_tokens=max_tokens or self.max_tokens,
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
        """Document embeddings in input order, EMBEDDING_DIMENSIONS floats
        each, in provider-sized batches."""
        return await self._embed(texts, "passage")

    async def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        """Search queries' embeddings (asymmetric models embed them differently
        from documents); same shape as ``embed``, for the retriever."""
        return await self._embed(texts, "query")

    async def _embed(self, texts: Sequence[str], kind: str) -> list[list[float]]:
        profile = self.profile
        extra = {"input_type": kind} if profile.embed_input_type else None
        vectors: list[list[float]] = []
        for start in range(0, len(texts), profile.embed_batch):
            batch = list(texts[start : start + profile.embed_batch])
            response = await self.openai.embeddings.create(
                model=profile.embed_model,
                input=batch,
                dimensions=profile.embed_dimensions,
                extra_body=extra,
            )
            ordered = sorted(response.data, key=lambda item: item.index)
            vectors.extend(fit_dimensions(item.embedding) for item in ordered)
        return vectors

    async def aclose(self) -> None:
        await self.http.aclose()
        if self.fallback is not None:
            await self.fallback.aclose()


def build_clients(
    profile: ProviderProfile,
    *,
    gate: UsageGate,
    daily: DailyCounter,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    inner: httpx.AsyncBaseTransport | None = None,
    fallback: ProviderProfile | None = None,
    fallback_gate: UsageGate | None = None,
    fallback_inner: httpx.AsyncBaseTransport | None = None,
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
        allowed_models=frozenset({profile.chat_model, profile.embed_model} - {""}),
        gate=gate,
        daily=daily,
        default_max_tokens=max_tokens,
    )
    http = httpx.AsyncClient(transport=transport, timeout=REQUEST_TIMEOUT_SECONDS)
    key = "fake" if not profile.api_key_env else os.environ.get(profile.api_key_env, "missing")
    client = AsyncOpenAI(base_url=profile.base_url, api_key=key, http_client=http, max_retries=0)
    backup = (
        build_clients(
            fallback,
            gate=fallback_gate or gate,
            daily=daily,
            max_tokens=max_tokens,
            inner=fallback_inner,
        )
        if fallback is not None
        else None
    )
    return LlmClients(
        profile=profile, openai=client, http=http, max_tokens=max_tokens, fallback=backup
    )
