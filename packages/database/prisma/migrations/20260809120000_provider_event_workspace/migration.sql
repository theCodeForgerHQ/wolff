-- Razorpay events are verified with one workspace's secret, so they must only
-- ever touch that workspace's payments. Record which workspace that was.
-- Existing rows stay NULL: none can be attributed after the fact, and the
-- reconcile job refuses a Razorpay event without a workspace.

-- AlterTable
ALTER TABLE "provider_webhook_events" ADD COLUMN     "workspace_id" TEXT;

-- CreateIndex
CREATE INDEX "provider_webhook_events_workspace_id_idx" ON "provider_webhook_events"("workspace_id");

-- AddForeignKey
ALTER TABLE "provider_webhook_events" ADD CONSTRAINT "provider_webhook_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
