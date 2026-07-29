-- One generated invoice per recurring parent and period.
-- The job that generates recurring invoices can run twice for the same
-- period (a retry, two workers, a drain overlapping the scheduler); the
-- unique index turns the second insert into a constraint error that the job
-- treats as "already done".
ALTER TABLE "invoices" ADD COLUMN     "recurring_period_key" VARCHAR(10);

-- Partial: only generated invoices take part. Prisma's schema cannot express
-- a partial index, so it exists only here.
CREATE UNIQUE INDEX "invoices_parent_period_key"
  ON "invoices" ("parent_invoice_id", "recurring_period_key")
  WHERE "parent_invoice_id" IS NOT NULL AND "recurring_period_key" IS NOT NULL;
