# Architecture decision records

Short records of the decisions that shape this project. Each says what was
decided, why, and what it costs. The phase documents in `docs/phase-*.md`
hold the evidence.

| ADR                                       | Decision                                                         |
| ----------------------------------------- | ---------------------------------------------------------------- |
| [0001](0001-free-stack-instead-of-aws.md) | Run the demo on card-free free tiers, not AWS                    |
| [0002](0002-qstash-schedules.md)          | Scheduled jobs run on QStash schedules                           |
| [0003](0003-transactional-outbox.md)      | A transactional outbox for every side effect                     |
| [0004](0004-tenant-guard.md)              | A Prisma tenant guard on every workspace-owned model             |
| [0005](0005-nim-and-groq.md)              | NVIDIA NIM for the LLM and embeddings, Groq as chat fallback     |
| [0006](0006-pgvector-halfvec.md)          | Store embeddings as pgvector `halfvec(2048)`                     |
| [0007](0007-api-v1-parity-port.md)        | Port `/api/v1` to Express behind a recorded-response parity test |
| [0008](0008-encrypted-logical-backups.md) | Nightly logical backups, encrypted, through the app's connection |
