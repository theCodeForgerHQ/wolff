-- Database-wide objects the AI service needs. Prisma owns
-- them so its shadow database has them too; Alembic owns only the tables
-- inside the `ai` schema. Prisma's datasource lists `public` only, so it
-- never diffs `ai`.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS ai;

-- Grants are guarded: the roles come from infra/db/bootstrap.sql, which a
-- shadow database or a fresh CI database may not have run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_reader') THEN
    GRANT USAGE ON SCHEMA public TO ai_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_reader;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ai_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_owner') THEN
    GRANT USAGE, CREATE ON SCHEMA ai TO ai_owner;
  END IF;
END $$;
