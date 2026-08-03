-- CreateEnum
CREATE TYPE "gst_registration_type" AS ENUM ('regular', 'composition', 'unregistered', 'overseas');

-- CreateEnum
CREATE TYPE "aggregate_turnover_band" AS ENUM ('le_5cr', 'gt_5cr');

-- CreateEnum
CREATE TYPE "item_type" AS ENUM ('goods', 'services');

-- CreateEnum
CREATE TYPE "supply_type" AS ENUM ('intra', 'inter', 'export', 'sez');

-- CreateEnum
CREATE TYPE "tax_rate_kind" AS ENUM ('generic', 'gst');

-- DropIndex
DROP INDEX "number_sequences_workspace_id_type_key";

-- AlterTable
ALTER TABLE "business_profiles" ADD COLUMN     "aggregate_turnover_band" "aggregate_turnover_band" NOT NULL DEFAULT 'le_5cr',
ADD COLUMN     "e_invoice_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "gst_registration_type" "gst_registration_type" NOT NULL DEFAULT 'unregistered',
ADD COLUMN     "gstin" VARCHAR(15),
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "lut_number" VARCHAR(50),
ADD COLUMN     "pan" VARCHAR(10),
ADD COLUMN     "state_code" VARCHAR(2);

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "country_code" VARCHAR(2) NOT NULL DEFAULT 'IN',
ADD COLUMN     "gstin" VARCHAR(15),
ADD COLUMN     "is_gst_registered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "state_code" VARCHAR(2);

-- AlterTable
ALTER TABLE "credit_note_line_items" ADD COLUMN     "cess_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cgst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cgst_rate" DECIMAL(5,2),
ADD COLUMN     "gst_rate" DECIMAL(5,2),
ADD COLUMN     "hsn_sac" VARCHAR(8),
ADD COLUMN     "igst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "igst_rate" DECIMAL(5,2),
ADD COLUMN     "item_type" "item_type" NOT NULL DEFAULT 'services',
ADD COLUMN     "sgst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sgst_rate" DECIMAL(5,2),
ADD COLUMN     "taxable_value" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "credit_notes" ADD COLUMN     "place_of_supply" VARCHAR(2),
ADD COLUMN     "recipient_gstin" VARCHAR(15),
ADD COLUMN     "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supplier_gstin" VARCHAR(15),
ADD COLUMN     "supply_type" "supply_type",
ADD COLUMN     "tax_breakup" JSONB;

-- AlterTable
ALTER TABLE "invoice_line_items" ADD COLUMN     "cess_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cgst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cgst_rate" DECIMAL(5,2),
ADD COLUMN     "gst_rate" DECIMAL(5,2),
ADD COLUMN     "hsn_sac" VARCHAR(8),
ADD COLUMN     "igst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "igst_rate" DECIMAL(5,2),
ADD COLUMN     "item_type" "item_type" NOT NULL DEFAULT 'services',
ADD COLUMN     "sgst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sgst_rate" DECIMAL(5,2),
ADD COLUMN     "taxable_value" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "ack_date" TIMESTAMP(3),
ADD COLUMN     "ack_no" VARCHAR(50),
ADD COLUMN     "irn" VARCHAR(64),
ADD COLUMN     "place_of_supply" VARCHAR(2),
ADD COLUMN     "recipient_gstin" VARCHAR(15),
ADD COLUMN     "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signed_qr_code" TEXT,
ADD COLUMN     "supplier_gstin" VARCHAR(15),
ADD COLUMN     "supply_type" "supply_type",
ADD COLUMN     "tax_breakup" JSONB;

-- AlterTable
ALTER TABLE "number_sequences" ADD COLUMN     "financial_year" VARCHAR(7);

-- AlterTable
ALTER TABLE "quote_line_items" ADD COLUMN     "gst_rate" DECIMAL(5,2),
ADD COLUMN     "hsn_sac" VARCHAR(8),
ADD COLUMN     "item_type" "item_type" NOT NULL DEFAULT 'services';

-- AlterTable
ALTER TABLE "rate_cards" ADD COLUMN     "gst_rate" DECIMAL(5,2),
ADD COLUMN     "hsn_sac" VARCHAR(8),
ADD COLUMN     "item_type" "item_type" NOT NULL DEFAULT 'services';

-- AlterTable
ALTER TABLE "saved_line_items" ADD COLUMN     "gst_rate" DECIMAL(5,2),
ADD COLUMN     "hsn_sac" VARCHAR(8),
ADD COLUMN     "item_type" "item_type" NOT NULL DEFAULT 'services';

-- AlterTable
ALTER TABLE "tax_rates" ADD COLUMN     "gst_rate" DECIMAL(5,2),
ADD COLUMN     "kind" "tax_rate_kind" NOT NULL DEFAULT 'generic';

-- CreateIndex
CREATE INDEX "business_profiles_gstin_idx" ON "business_profiles"("gstin");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_workspace_id_type_financial_year_key" ON "number_sequences"("workspace_id", "type", "financial_year");


-- Partial unique index for non-FY rows: Prisma cannot express partial
-- indexes, so we keep one row per workspace+type with no financial year
-- (non-GST workspaces) while allowing one row per FY for GST workspaces.
CREATE UNIQUE INDEX "number_sequences_workspace_id_type_null_fy"
  ON "number_sequences"("workspace_id", "type")
  WHERE "financial_year" IS NULL;
