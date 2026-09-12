# Contributing to Wolff

Wolff is built by two developers working on short-lived branches that the other
person reviews and merges. Outside contributions follow the same flow.

## Set up

Follow [Quick start](README.md#quick-start) in the README. You need Node 24,
Docker and pnpm 9.15. Read [docs/runbook.md](docs/runbook.md) before touching
jobs, backups or deploys, and the [ADRs](docs/adr/README.md) before changing a
decision they record.

## Branches

Work never lands on `main` directly. Branch from the latest `main`:

| Prefix      | For                         | Example                      |
| ----------- | --------------------------- | ---------------------------- |
| `feature/`  | new behaviour               | `feature/quote-pdf-export`   |
| `fix/`      | bugs                        | `fix/invoice-rounding`       |
| `chore/`    | tooling, deps, housekeeping | `chore/bump-prisma`          |
| `docs/`     | documentation only          | `docs/runbook-restore`       |
| `refactor/` | no behaviour change         | `refactor/quote-store`       |
| `test/`     | tests only                  | `test/stripe-webhook-replay` |

Keep a branch to one topic. A branch that grows past a few days of work should
be split.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, imperative, under 72 characters. Common scopes are
`web`, `api`, `core`, `db`, `jobs`, `ai`, `widget`, `e2e`, `ci`. Use the body
to say why, not what. One logical change per commit; formatting-only changes
go in their own commit.

The pre-commit hook runs lint-staged (ESLint and Prettier on staged files).
Don't bypass it.

## Before asking for review

All of these must pass locally:

```bash
pnpm type-check
pnpm lint
STRIPE_MOCK_URL=http://localhost:12111 pnpm test
```

Also, depending on what you touched:

- **Schema:** add a Prisma migration (`pnpm db:migrate`) and run
  `pnpm db:migrate:check`. Never edit a migration that has shipped.
- **AI service:** `cd services/ai && uv run pytest`, and add an Alembic
  revision for any `ai` schema change.
- **User-facing flows:** the Playwright flows in `apps/web/e2e` (see
  [Tests and CI](README.md#tests-and-ci)). Update visual baselines only when
  the change is intended, and say so in the review.
- **Public API:** regenerate `apps/api/openapi.json`
  (`pnpm --filter @wolff/api openapi:gen`) and update
  [docs/API_REFERENCE.md](docs/API_REFERENCE.md).

New behaviour needs tests. Bug fixes need a test that failed before the fix.

## Review and merge

- The person who didn't write the branch reviews it. Fill in the
  [pull request template](.github/pull_request_template.md).
- The reviewer checks it out and runs it, not just reads the diff.
- The reviewer merges with `--no-ff` so the branch stays visible in history,
  then deletes the branch.
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) must be green.

## Security and secrets

Never commit secrets, `.env` files or real customer data. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in
an issue.

## Conduct and licence

Contributors follow the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions
are licensed under the repository [licence](LICENSE) and the terms in
[CLA.md](CLA.md).
