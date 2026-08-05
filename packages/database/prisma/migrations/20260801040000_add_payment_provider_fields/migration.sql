-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "access_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "access_token_rotated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payment_settings" ADD COLUMN     "active_providers" "payment_provider"[] DEFAULT ARRAY['stripe']::"payment_provider"[],
ADD COLUMN     "default_provider_by_currency" JSONB NOT NULL DEFAULT '{"*":"stripe"}',
ADD COLUMN     "razorpay_key_id" VARCHAR(40),
ADD COLUMN     "razorpay_key_secret_enc" TEXT,
ADD COLUMN     "razorpay_verified_at" TIMESTAMP(3),
ADD COLUMN     "razorpay_webhook_secret_enc" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "provider" "payment_provider" NOT NULL DEFAULT 'stripe',
ADD COLUMN     "provider_fee" DECIMAL(12,2),
ADD COLUMN     "provider_order_id" VARCHAR(100),
ADD COLUMN     "provider_payment_id" VARCHAR(100),
ADD COLUMN     "provider_signature" TEXT,
ADD COLUMN     "raw_event" JSONB;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "access_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "access_token_rotated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "queue" VARCHAR(50) NOT NULL,
    "job_id" VARCHAR(100) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "workspace_id" TEXT,
    "status" VARCHAR(20) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_runs_queue_status_idx" ON "job_runs"("queue", "status");

-- CreateIndex
CREATE INDEX "job_runs_workspace_id_idx" ON "job_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "job_runs_job_id_idx" ON "job_runs"("job_id");

-- CreateIndex
CREATE INDEX "payments_provider_payment_id_idx" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_payment_id_key" ON "payments"("provider", "provider_payment_id");

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

