-- Roles for services/ai. Run once per cluster, as the
-- database owner, after `prisma migrate deploy`; it is idempotent:
--
--   AI_DB_PASSWORD=... psql "$DIRECT_URL" -f infra/db/bootstrap.sql
--
-- ai_reader may only read `public` (the Prisma tables). ai_owner owns the
-- `ai` schema's tables (Alembic runs `SET ROLE ai_owner`). ai_service is the
-- login the AI service and Alembic connect with; it holds both roles and
-- nothing else, so the AI service cannot write a business table.
\set ON_ERROR_STOP on
\getenv ai_password AI_DB_PASSWORD
\if :{?ai_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'AI_DB_PASSWORD is not set'; END $$;
\endif

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_reader') AS create_reader \gset
\if :create_reader
  CREATE ROLE ai_reader NOLOGIN;
\endif
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_owner') AS create_owner \gset
\if :create_owner
  CREATE ROLE ai_owner NOLOGIN;
\endif
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_service') AS create_service \gset
\if :create_service
  CREATE ROLE ai_service LOGIN;
\endif
ALTER ROLE ai_service WITH LOGIN PASSWORD :'ai_password';
GRANT ai_reader, ai_owner TO ai_service;

-- The same grants as the Prisma migration, for a database migrated before
-- these roles existed.
CREATE SCHEMA IF NOT EXISTS ai;
GRANT USAGE ON SCHEMA public TO ai_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ai_reader;
GRANT USAGE, CREATE ON SCHEMA ai TO ai_owner;
