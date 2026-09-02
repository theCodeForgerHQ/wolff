# ADR 0001: Run the demo on card-free free tiers, not AWS

- Status: accepted (2026-08-23; supersedes the AWS/Terraform plan)
- Phase docs: [phase-2](../phase-2.md), [phase-6](../phase-6.md), [free-tier](../free-tier.md), [runbook](../runbook.md)

## Context

The original plan was an AWS deployment (ECS Fargate, RDS, ElastiCache,
Terraform), applied on demand for interviews at about $3 a day. The demo must
also stay reachable from a résumé link at no cost, and the owner's rule is
that nothing may be billed: no service that needs a card on file.

## Decision

Drop AWS and Terraform. The demo runs entirely on free tiers that need no
card:

| Piece                                      | Service                                           |
| ------------------------------------------ | ------------------------------------------------- |
| web (Next.js), api (Express), ai (FastAPI) | three Vercel Hobby projects (functions)           |
| Postgres 17 + pgvector                     | Neon free                                         |
| Immediate and scheduled jobs               | Upstash QStash (push to signed `/jobs/run/:type`) |
| BullMQ queue store                         | Redis Cloud free (used by drains and local runs)  |
| Web rate limits                            | Upstash Redis                                     |
| Object storage (PDFs, backups)             | Supabase Storage through its S3 API               |
| Errors and alerts                          | Sentry developer tier, UptimeRobot                |

There is no always-on server. Code stays portable: the same job processors
run under BullMQ locally (`pnpm worker`) and from QStash on Vercel, storage
goes through one S3 driver, and Postgres is reached through Prisma driver
adapters.

## Consequences

- Monthly cost is $0, and no bill is possible.
- Function limits shape the code: 300 s per call (backups and the AI sweep
  work in bounded batches), 4.5 MB bodies, no long-lived connections (MCP is
  stateless over HTTP).
- Operations are Vercel deploys plus Instant Rollback, Neon branches for
  point-in-time restore, and a logical backup job (ADR 0008), not ECS and RDS.
- Free-tier limits change without notice; they are recorded with the date
  checked in `docs/free-tier.md`.
- Infrastructure-as-code and container orchestration are not demonstrated by
  this project.
