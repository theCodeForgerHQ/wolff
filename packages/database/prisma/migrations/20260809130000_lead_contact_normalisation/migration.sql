-- Lead import dedupes on email (compared lower-case) and phone (digits, with
-- a leading "+" kept). Bring existing rows into that form; new rows are
-- written in it by core/crm/leads.ts.

-- Lower-case emails, except where that would collide with another lead of
-- the same workspace (those stay as they are and can be merged by hand).
UPDATE "leads" AS l
SET "email" = lower(l."email")
WHERE l."email" IS NOT NULL
  AND l."email" <> lower(l."email")
  AND NOT EXISTS (
    SELECT 1 FROM "leads" o
    WHERE o."workspace_id" = l."workspace_id" AND o."email" = lower(l."email")
  );

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
