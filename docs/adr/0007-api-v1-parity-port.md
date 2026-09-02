# ADR 0007: Port `/api/v1` to the Express API behind a recorded-response parity test

- Status: accepted (Phase 6b)
- Phase docs: [phase-6b](../phase-6b.md)

## Context

The Next.js app served its public REST API from 11 Next.js route files.
The new Express API (`apps/api`) owns auth, scopes, idempotency, rate limits
and OpenAPI. Two implementations of one public contract drift, and
integrators must not notice the move.

## Decision

Before porting, record the Next routes' real responses: a fixed seed and a
scenario of 112 requests covering every route file and method (success
paths, each validation message, cross-workspace ids, pagination, GST
refusals, the 401 shapes). Port the routes to `apps/api/src/routes/v1/legacy/`
and compare each response with the recording after normalising only what
differs between runs (generated ids, timestamps, relative dates). Then
rewrite `/api/v1/*` on Vercel to the API (`API_V1_UPSTREAM`, in `proxy.ts`),
keep the Next routes one week as the fallback, and delete them.

Deliberate differences are listed, not hidden: auth failures use the
standard envelope, inputs that crashed the old routes now get a 4xx, and
the ported routes enforce scopes the old ones did not check.

## Consequences

- 112 of 112 recorded responses match after normalisation; changing one
  error message fails four cases.
- Schemathesis fuzzes all 51 OpenAPI operations (about 4,000 cases, 0
  failures locally).
- One implementation remains after the deletion date; until then a single
  env var switches back.
