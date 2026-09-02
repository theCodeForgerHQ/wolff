# ADR 0002: Scheduled jobs run on QStash schedules

- Status: accepted (2026-08-23)
- Phase docs: [phase-5](../phase-5.md) (fix-and-verify pass), [phase-6](../phase-6.md), [runbook §1](../runbook.md)

## Context

Recurring invoices, reminders, overdue marking, automations, the outbox
sweeper, the AI re-embedding sweep, nightly reports and the backup must run
on a schedule. The first plan was a GitHub Actions cron that starts the
BullMQ worker, drains due work and exits. That needs a pushed repository,
private repositories have a limited minute quota, and scheduled workflows
are disabled after 60 days without activity. There is no pushed repository.

## Decision

Each scheduled job is a QStash schedule that POSTs a job to the api's
signed endpoint `/jobs/run/:type`, the same endpoint immediate jobs use. The
schedules are defined in code (`QSTASH_SCHEDULES`, `packages/jobs/src/qstash.ts`,
eight entries, under the free plan's 10) and created idempotently by
`syncQStashSchedules`. The endpoint verifies the `Upstash-Signature` against
the raw body and URL and runs the same processor function BullMQ would.
`jobs-drain.yml` stays as an optional fallback for when a repository exists.

## Consequences

- Scheduled work runs with nothing on the owner's machine; verified on the
  live demo (every schedule DELIVERED 200, phase-5 doc).
- Each run must finish within Vercel's 300 s, so long jobs are bounded and
  resume from a cursor or the outbox.
- QStash's free 1,000 messages a day cap demo activity; over the cap, work
  waits for the next sweep.
- Schedules are external state: a changed cron needs `syncQStashSchedules`
  to run again.
