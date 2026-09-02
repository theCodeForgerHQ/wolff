# ADR 0005: NVIDIA NIM for the LLM and embeddings, Groq as chat fallback

- Status: accepted (2026-08-23; supersedes the Gemini-by-default plan)
- Phase docs: [phase-5](../phase-5.md) (deviation 17, live eval), [free-tier](../free-tier.md)

## Context

The AI service needs a chat model with tool calls and JSON-schema output and
an embedding model, free and without a card. The spec chose the Gemini free
tier. On a new key every available Gemini model is a Gemini 3 thinking model
whose tool calls need thought signatures that langchain-openai drops, and
the free quota was 20 requests a day, so chat and quote drafts could not
work.

## Decision

`LLM_PROVIDER=nvidia`: NVIDIA NIM's free API, chat
`nvidia/nemotron-3-super-120b-a12b`, embeddings `nvidia/nemotron-3-embed-1b`.
`LLM_FALLBACK=groq` (`openai/gpt-oss-120b`) answers chat only when NIM fails.
Both use the OpenAI SDK interface, each through its own rate-limited,
budget-gated transport. Gemini and OpenAI remain selectable providers; an
offline `fake` provider serves tests and CI.

## Consequences

- Chat with citations and quote drafts work on the live demo; the live eval
  scores are in the README with their caveats.
- Latency is high from a free endpoint: the live eval's p95 was 64.5 s, and
  9 of 14 drafts hit the 60 s wall clock when run from India against a
  us-east-1 database.
- The fallback uses a smaller prompt to fit Groq's token-per-minute limit
  (50 s end to end when forced, measured locally).
- The embedding model serves 2,048 dimensions only, which forced ADR 0006.
- Free endpoints may use prompts for training; demo data is synthetic.
