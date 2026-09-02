# ADR 0003: A transactional outbox for every side effect

- Status: accepted (Phase 2)
- Phase docs: [phase-2](../phase-2.md), [phase-4](../phase-4.md)

## Context

A business change often needs work outside the database: send an email,
render a PDF, deliver an outbound webhook, re-index a document for the AI
search, reconcile a payment. Writing the row and then enqueueing a job can
lose the job (the process dies between the two) or enqueue a job for a row
that was rolled back.

## Decision

The change and an `OutboxEvent` row describing it are written in one
database transaction (`packages/core/src/outbox`). A relay moves due events
to the job queue: immediately after commit (QStash push, or BullMQ locally),
and a scheduled sweeper requeues anything pending or stale. The row is the
record, not the queue: an event is `done` only when its job finished. Jobs
are keyed by the outbox id, and payloads carry ids only, never personal data.

## Consequences

- Losing Redis or a QStash message loses no work; the sweeper refills from
  the table (chaos test: `packages/jobs/src/bullmq.test.ts`, "when Redis is
  lost").
- Every job must be idempotent, because a job can run more than once.
  Emails carry a provider idempotency key; PDFs render once per document
  version.
- Work that is not pushed immediately waits for the next sweep, up to 15
  minutes on the demo.
- The relay and sweeper read across workspaces, one of the tenant guard's
  documented exemptions (ADR 0004).
