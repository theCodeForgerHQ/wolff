-- Lead import dedupes on email (compared lower-case) and phone (digits, with
-- a leading "+" kept). Bring existing rows into that form; new rows are
-- written in it by core/crm/leads.ts.

-- Lower-case emails. Leads of one workspace whose emails differ only by
-- case would all become the same address, which the unique key on
-- (workspace_id, email) refuses, so per group exactly one is chosen,
-- deterministically: a lead already in lower case, else the oldest, then
-- the lowest id. That one is lower-cased; the others keep their email and
-- get a note naming it, to be merged by hand (a merge would have to move
-- deals and activity, which a migration should not decide).
UPDATE "leads" AS l
SET "message" = concat_ws(
  E'\n\n',
  l."message",
  'Possible duplicate of lead ' || r."keeper" || ' (same email, different case); not merged automatically.'
)
FROM (
  SELECT "id",
    row_number() OVER w AS "rank",
    first_value("id") OVER w AS "keeper"
  FROM "leads"
  WHERE "email" IS NOT NULL
  WINDOW w AS (
    PARTITION BY "workspace_id", lower("email")
    ORDER BY ("email" = lower("email")) DESC, "created_at", "id"
  )
) AS r
WHERE l."id" = r."id" AND r."rank" > 1;

UPDATE "leads" AS l
SET "email" = lower(l."email")
FROM (
  SELECT "id",
    row_number() OVER (
      PARTITION BY "workspace_id", lower("email")
      ORDER BY ("email" = lower("email")) DESC, "created_at", "id"
    ) AS "rank"
  FROM "leads"
  WHERE "email" IS NOT NULL
) AS r
WHERE l."id" = r."id" AND r."rank" = 1 AND l."email" <> lower(l."email");

-- Phones: digits only, a leading "+" kept; no digits at all becomes NULL.
UPDATE "leads"
SET "phone" = CASE
  WHEN regexp_replace("phone", '\D', '', 'g') = '' THEN NULL
  WHEN btrim("phone") LIKE '+%' THEN '+' || regexp_replace("phone", '\D', '', 'g')
  ELSE regexp_replace("phone", '\D', '', 'g')
END
WHERE "phone" IS NOT NULL;

-- CreateIndex
CREATE INDEX "leads_workspace_id_phone_idx" ON "leads"("workspace_id", "phone");
