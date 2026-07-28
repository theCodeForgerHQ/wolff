-- State that outbound delivery keeps per endpoint: the
-- payload version it receives, and the run of failed deliveries that
-- disables it at 20. Additive.
ALTER TABLE "webhook_endpoints" ADD COLUMN     "api_version" VARCHAR(10) NOT NULL DEFAULT '2026-10',
ADD COLUMN     "disabled_at" TIMESTAMP(3),
ADD COLUMN     "failure_count" INTEGER NOT NULL DEFAULT 0;
