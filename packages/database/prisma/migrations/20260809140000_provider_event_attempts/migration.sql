-- Count failed processing attempts so an event that can never be applied is
-- dead-lettered (status failed) instead of being re-driven forever.

-- AlterTable
ALTER TABLE "provider_webhook_events" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;
