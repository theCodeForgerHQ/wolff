# ADR 0004: A Prisma tenant guard on every workspace-owned model

- Status: accepted (Phase 2, extended in Phases 3-4)
- Phase docs: [phase-2](../phase-2.md), [phase-4](../phase-4.md) (M2), [phase-6b](../phase-6b.md)

## Context

Every business table belongs to a workspace. A single query that forgets
`workspaceId` leaks or changes another tenant's data, and code review alone
did not catch it: the original `/api/v1` routes had six updates by `id` only.

## Decision

`withTenantGuard` (`packages/database/src/tenant-guard.ts`) is a Prisma
client extension that refuses a read, update or delete on a workspace-owned
model unless its `where` pins the workspace: `workspaceId` as a non-empty
string or `in` list, inside the top level or an `AND` branch (never `OR` or
`NOT`), or through the parent relation for child models such as line items.
Models are listed explicitly (`WORKSPACE_SCOPED_MODELS`,
`PARENT_SCOPED_MODELS`). Cross-workspace work (outbox relay, webhook
reconciliation) must use `$unscoped`, which makes the exemption visible in
the code. The guard does not decide which workspace a caller may use;
authentication does.

## Consequences

- A missing filter fails loudly in tests instead of returning another
  tenant's rows.
- Cross-tenant suites check the behaviour from outside:
  `apps/api/src/routes/v1/cross-tenant.test.ts` and the AI service's
  isolation suite (`pytest -m isolation`, 0 leaks).
- New models must be added to the list, or they are not guarded; the guard's
  own tests check the list against the schema.
