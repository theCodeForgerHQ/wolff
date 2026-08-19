"""A deterministic, offline OpenAI-compatible endpoint (LLM_PROVIDER=fake).

There is no provider key in this project's environment, so tests, the
recorded eval run and local E2E talk to this instead. It is an httpx
transport: the real OpenAI SDK and LangChain code paths run unchanged,
and only the model's answers are simulated.

- ``/embeddings``: a hashed bag of words, L2-normalised to 1536 floats, so
  texts sharing words are close. Retrieval quality measured with it is
  lexical, not semantic.
- ``/chat/completions``: when tools are offered and the conversation has
  no tool result yet, it calls one tool picked by keywords; after a tool
  result it answers from that result, citing ``[1]`` for documents. With a
  ``json_schema`` response format it fills the schema from the
  conversation (see ``_structured``).

It does not follow instructions found in documents, so it cannot show
prompt-injection behaviour; the guards against that are in our code.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

import httpx2 as httpx

DIMENSIONS = 1536
_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset(
    "a an the of to for in on and or is are was were be by with what which who how my me i "
    "we our do does did show list give tell about from at this that it".split()
)

#: (keyword, tool) in priority order; the first keyword found picks the tool.
_ROUTES: tuple[tuple[str, str], ...] = (
    ("draft", "draft_quote"),
    ("overdue", "list_overdue_invoices"),
    ("who owes", "top_debtors"),
    ("owes me most", "top_debtors"),
    ("owe", "receivables_ageing"),
    ("outstanding", "receivables_ageing"),
    ("ageing", "receivables_ageing"),
    ("gst", "gst_summary"),
    ("lead", "list_leads"),
    ("deal", "list_deals"),
    ("pipeline", "list_deals"),
)


def words(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


def embed(text: str) -> list[float]:
    vector = [0.0] * DIMENSIONS
    for word in words(text):
        digest = hashlib.blake2b(word.encode(), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "big") % DIMENSIONS
        vector[index] += 1.0 if digest[4] & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


def _tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, list):
        return " ".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return str(content or "")


def _last_user(messages: list[dict[str, Any]]) -> str:
    return next((_text(m) for m in reversed(messages) if m.get("role") == "user"), "")


def _pick_tool(question: str, tools: list[dict[str, Any]]) -> tuple[str, dict[str, Any]] | None:
    available = {t["function"]["name"]: t["function"] for t in tools if "function" in t}
    lowered = question.lower()
    for keyword, name in _ROUTES:
        if keyword in lowered and name in available:
            return name, _arguments(name, question, available[name])
    if "search_documents" in available:
        return "search_documents", {"query": question}
    return None


def _arguments(name: str, question: str, function: dict[str, Any]) -> dict[str, Any]:
    properties = (function.get("parameters") or {}).get("properties") or {}
    args: dict[str, Any] = {}
    if "query" in properties:
        args["query"] = question
    if "brief" in properties:
        args["brief"] = question
    return args


_TAG = re.compile(r"</?document[^>]*>")
_SENTENCE = re.compile(r"(?<=[.!?])\s+|\n+")


def _best_sentence(question: str, content: str) -> str:
    """The sentence sharing the most words with the question (extractive)."""
    wanted = set(words(question))
    sentences = [x.strip() for x in _SENTENCE.split(_TAG.sub("", content)) if x.strip()]
    if not sentences:
        return ""
    return max(sentences, key=lambda x: len(wanted & set(words(x))))


def _answer_from_tool(question: str, content: str) -> str:
    try:
        data = json.loads(content)
    except ValueError:
        data = content
    if isinstance(data, dict) and isinstance(data.get("documents"), list):
        docs = data["documents"]
        if not docs:
            return "I couldn't find that in your documents."
        return f"{_best_sentence(question, str(docs[0].get('content', '')))} [1]"
    return "Here is what I found: " + (content if len(content) < 1500 else content[:1500])


def _structured(name: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    builder = STRUCTURED.get(name)
    if builder is None:
        raise ValueError(f"the fake model has no builder for schema {name!r}")
    result: dict[str, Any] = builder(messages)
    return result


#: Builders for structured outputs, by json_schema name. The quote agent
#: registers one (app/agent/fake_draft.py).
STRUCTURED: dict[str, Any] = {}


def _chat(body: dict[str, Any]) -> dict[str, Any]:
    messages: list[dict[str, Any]] = body.get("messages") or []
    prompt = " ".join(_text(m) for m in messages)
    message: dict[str, Any] = {"role": "assistant", "content": None}
    response_format = body.get("response_format") or {}
    tools = body.get("tools") or []
    has_tool_result = any(m.get("role") == "tool" for m in messages)

    if response_format.get("type") == "json_schema":
        schema_name = response_format["json_schema"]["name"]
        message["content"] = json.dumps(_structured(schema_name, messages))
    elif tools and not has_tool_result and (picked := _pick_tool(_last_user(messages), tools)):
        name, args = picked
        call_id = "call_" + hashlib.sha1(prompt.encode()).hexdigest()[:12]  # noqa: S324
        message["tool_calls"] = [
            {
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
        ]
    elif has_tool_result:
        last_tool = next(m for m in reversed(messages) if m.get("role") == "tool")
        message["content"] = _answer_from_tool(_last_user(messages), _text(last_tool))
    else:
        message["content"] = "I can answer questions about your quotes, invoices and contracts."

    output = json.dumps(message)
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "created": 0,
        "model": body.get("model", "fake-chat"),
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if message.get("tool_calls") else "stop",
            }
        ],
        "usage": {
            "prompt_tokens": _tokens(prompt),
            "completion_tokens": _tokens(output),
            "total_tokens": _tokens(prompt) + _tokens(output),
        },
    }


def _embeddings(body: dict[str, Any]) -> dict[str, Any]:
    raw = body.get("input")
    inputs = [raw] if isinstance(raw, str) else list(raw or [])
    return {
        "object": "list",
        "model": body.get("model", "fake-embed"),
        "data": [
            {"object": "embedding", "index": i, "embedding": embed(str(text))}
            for i, text in enumerate(inputs)
        ],
        "usage": {"prompt_tokens": sum(_tokens(str(t)) for t in inputs), "total_tokens": 0},
    }


class FakeOpenAITransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(await request.aread() or b"{}")
        path = request.url.path
        if path.endswith("/embeddings"):
            return httpx.Response(200, json=_embeddings(body), request=request)
        if path.endswith("/chat/completions"):
            if body.get("stream"):
                return httpx.Response(400, json={"error": {"message": "stream not supported"}})
            return httpx.Response(200, json=_chat(body), request=request)
        return httpx.Response(404, json={"error": {"message": f"no route {path}"}})
