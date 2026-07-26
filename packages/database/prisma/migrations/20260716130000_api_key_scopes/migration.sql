-- API keys gain a kind, scopes, an origin allowlist and a per-key rate limit.
-- Additive: the previous release ignores the new columns.
-- CreateEnum
CREATE TYPE "api_key_kind" AS ENUM ('secret', 'publishable');

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "allowed_origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "kind" "api_key_kind" NOT NULL DEFAULT 'secret',
ADD COLUMN     "rate_limit_per_min" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];


-- Every key that exists now was created before scopes did. Give each what it
-- could already do: all scopes except the new webhooks:manage.
UPDATE "api_keys"
SET "scopes" = ARRAY[
  'leads:read', 'leads:write', 'deals:read', 'deals:write',
  'clients:read', 'clients:write', 'quotes:read', 'quotes:write',
  'invoices:read', 'invoices:write', 'payments:read', 'payments:write',
  'reports:read', 'ai:use'
]::TEXT[]
WHERE "kind" = 'secret' AND "scopes" = ARRAY[]::TEXT[];
