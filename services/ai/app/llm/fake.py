"""A deterministic, offline OpenAI-compatible endpoint (LLM_PROVIDER=fake).

There is no provider key in this project's environment, so tests, the
recorded eval run and local E2E talk to this instead. It is an httpx
transport: the real OpenAI SDK and LangChain code paths run unchanged,
and only the model's answers are simulated.

- ``/embeddings``: a hashed bag of words, L2-normalised to 2048 floats, so
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

DIMENSIONS = 2048
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


_CLIENT_REF = re.compile(r"\bfor ([^:,.\n]+)", re.I)
_QUOTE_PLAN = ("get_client", "list_rate_cards", "get_past_quotes")


def _tool_results(messages: list[dict[str, Any]]) -> list[Any]:
    out = []
    for m in messages:
        if m.get("role") == "tool":
            try:
                out.append(json.loads(_text(m)))
            except ValueError:
                continue
    return out


def _called(messages: list[dict[str, Any]]) -> list[str]:
    return [
        call["function"]["name"]
        for m in messages
        if m.get("role") == "assistant"
        for call in m.get("tool_calls") or []
    ]


def _first_user(messages: list[dict[str, Any]]) -> str:
    return next((_text(m) for m in messages if m.get("role") == "user"), "")


def _quote_step(messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
    """The quote agent's fact gathering: client, then rate cards, then past quotes."""
    names = {t["function"]["name"] for t in tools if "function" in t}
    done = _called(messages)
    client = next(
        (r for r in _tool_results(messages) if isinstance(r, dict) and "client_id" in r), None
    )
    if "get_client" in done and client is None:
        return {"content": "I could not find that client."}
    for name in _QUOTE_PLAN:
        if name in names and name not in done:
            if name == "get_client":
                match = _CLIENT_REF.search(_first_user(messages))
                args: dict[str, Any] = {"ref": match.group(1).strip() if match else ""}
            elif name == "get_past_quotes":
                args = {"client_id": client["client_id"] if client else None}
            else:
                args = {}
            call_id = f"call_{name}_{len(done)}"
            return {
                "tool_calls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)},
                    }
                ]
            }
    return {"content": "I have what I need to draft the quote."}


def _quote_draft(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """QuoteDraft from the gathered facts: rate cards sharing words with the brief."""
    brief = _first_user(messages)
    results = _tool_results(messages)
    client = next((r for r in results if isinstance(r, dict) and "client_id" in r), None)
    cards = next((r for r in results if isinstance(r, list) and r and "rate_card_id" in r[0]), [])
    wanted = set(words(brief))
    chosen = [c for c in cards if wanted & set(words(c["name"]))] or cards[:1]
    lines = [
        {
            "name": c["name"],
            "description": c.get("description"),
            "qty": 1,
            "unit": c.get("unit"),
            "rate": c["rate"],
            "hsn_sac": c.get("hsn_sac"),
            "source": "rate_card",
            "source_ref": c["rate_card_id"],
        }
        for c in chosen
    ] or [
        {
            "name": "Services",
            "description": None,
            "qty": 1,
            "unit": None,
            "rate": 0,
            "hsn_sac": None,
            "source": "new",
            "source_ref": None,
        }
    ]
    title = brief.split(":", 1)[-1].strip()[:80] or "Draft quote"
    return {
        "client_id": client["client_id"] if client else "",
        "deal_id": None,
        "title": title[:1].upper() + title[1:],
        "currency": "INR" if not client or client.get("country_code") in (None, "IN") else "USD",
        "line_items": lines,
        "terms": None,
        "notes": None,
        "assumptions": ["Quantities assumed to be 1; confirm with the client."],
        "confidence": 0.6 if client else 0.0,
    }


STRUCTURED_DEFAULTS = {"QuoteDraft": _quote_draft}


def _structured(name: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    builder = STRUCTURED.get(name) or STRUCTURED_DEFAULTS.get(name)
    if builder is None:
        raise ValueError(f"the fake model has no builder for schema {name!r}")
    result: dict[str, Any] = builder(messages)
    return result


#: Extra builders for structured outputs, by json_schema name (tests).
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
    elif any(t.get("function", {}).get("name") == "get_client" for t in tools):
        message.update(_quote_step(messages, tools))
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
