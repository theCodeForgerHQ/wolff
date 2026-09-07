-- One automation run per automation and subject. The trigger scan checked
-- for an existing run and then created one, so two overlapping scans (a
-- QStash redelivery) could both create it. Keep the oldest run of any pair
-- that already has more than one, then enforce it.
DELETE FROM "automation_runs" AS r
USING "automation_runs" AS keep
WHERE r."automation_id" = keep."automation_id"
  AND r."subject_id" = keep."subject_id"
  AND (keep."created_at", keep."id") < (r."created_at", r."id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_automation_id_subject_id_key" ON "automation_runs"("automation_id", "subject_id");
