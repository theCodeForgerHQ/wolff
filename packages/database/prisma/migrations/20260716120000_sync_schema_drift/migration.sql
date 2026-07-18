-- DropForeignKey
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_uploaded_by_id_fkey";

-- DropForeignKey
ALTER TABLE "contract_instances" DROP CONSTRAINT "contract_instances_client_id_fkey";

-- DropForeignKey
ALTER TABLE "contract_instances" DROP CONSTRAINT "contract_instances_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_client_id_fkey";

-- DropForeignKey
ALTER TABLE "workspace_invitations" DROP CONSTRAINT "workspace_invitations_invited_by_id_fkey";

-- DropForeignKey
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_owner_id_fkey";

-- DropIndex
DROP INDEX "clients_workspace_id_created_at_idx";

-- DropIndex
DROP INDEX "contract_instances_access_token_idx";

-- DropIndex
DROP INDEX "contract_instances_workspace_id_created_at_idx";

-- DropIndex
DROP INDEX "contracts_workspace_id_created_at_idx";

-- DropIndex
DROP INDEX "invoices_access_token_idx";

-- DropIndex
DROP INDEX "invoices_workspace_id_created_at_idx";

-- DropIndex
DROP INDEX "quotes_access_token_idx";

-- DropIndex
DROP INDEX "quotes_workspace_id_created_at_idx";

-- DropIndex
DROP INDEX "users_email_idx";

-- AlterTable
ALTER TABLE "attachments" ALTER COLUMN "file_size" SET DATA TYPE BIGINT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "contract_instances" ALTER COLUMN "contract_id" DROP NOT NULL,
ALTER COLUMN "client_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "workspace_members" ALTER COLUMN "role" SET DATA TYPE VARCHAR(20);

-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "owner_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "clients_workspace_id_email_key" ON "clients"("workspace_id", "email");

-- CreateIndex
CREATE INDEX "invoice_events_actor_id_idx" ON "invoice_events"("actor_id");

-- CreateIndex
CREATE INDEX "quote_events_actor_id_idx" ON "quote_events"("actor_id");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_instances" ADD CONSTRAINT "contract_instances_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

