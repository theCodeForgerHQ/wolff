-- Payments and webhook deliveries get their own workspace_id so they can be
-- listed and guarded per tenant without a join. Additive and
-- nullable: the previous release still inserts rows without it.
-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "workspace_id" TEXT;

-- AlterTable
ALTER TABLE "webhook_deliveries" ADD COLUMN     "workspace_id" TEXT;

-- CreateIndex
CREATE INDEX "payments_workspace_id_created_at_idx" ON "payments"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_workspace_id_created_at_idx" ON "webhook_deliveries"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill from the parent row.
UPDATE "payments" p
SET "workspace_id" = i."workspace_id"
FROM "invoices" i
WHERE i."id" = p."invoice_id" AND p."workspace_id" IS NULL;

UPDATE "webhook_deliveries" d
SET "workspace_id" = e."workspace_id"
FROM "webhook_endpoints" e
WHERE e."id" = d."endpoint_id" AND d."workspace_id" IS NULL;
