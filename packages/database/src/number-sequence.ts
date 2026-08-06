import { Prisma, type Prisma as PrismaTypes } from './generated/prisma/client';

export interface NumberSequenceDefaults {
  prefix: string;
  currentValue: number;
  padding: number;
}

export interface NumberSequenceResult {
  prefix: string | null;
  suffix: string | null;
  currentValue: number;
  padding: number;
}

/**
 * Atomically increment (or create) a NumberSequence row.
 *
 * Prisma 7.10 rejects `null` in compound unique-key `where` clauses even when
 * the field is nullable. The schema uses a partial unique index for rows where
 * `financialYear` is null (non-GST workspaces) and a full unique index for rows
 * with a financial year (GST workspaces). This helper uses a raw PostgreSQL
 * upsert so the operation stays atomic and works for both cases.
 */
export async function incrementNumberSequence(
  tx: PrismaTypes.TransactionClient,
  workspaceId: string,
  type: string,
  financialYear: string | null,
  defaults: NumberSequenceDefaults
): Promise<NumberSequenceResult> {
  const rows = await tx.$queryRaw<
    Array<{
      prefix: string | null;
      suffix: string | null;
      current_value: number;
      padding: number;
    }>
  >`
    INSERT INTO "number_sequences" (
      "id", "workspace_id", "type", "financial_year",
      "prefix", "current_value", "padding", "created_at", "updated_at"
    ) VALUES (
      gen_random_uuid(), ${workspaceId}, ${type}, ${financialYear},
      ${defaults.prefix}, ${defaults.currentValue}, ${defaults.padding}, NOW(), NOW()
    )
    ${
      financialYear === null
        ? Prisma.raw(`ON CONFLICT ("workspace_id", "type") WHERE "financial_year" IS NULL`)
        : Prisma.raw(`ON CONFLICT ("workspace_id", "type", "financial_year")`)
    }
    DO UPDATE SET
      "current_value" = "number_sequences"."current_value" + 1,
      "updated_at" = NOW()
    RETURNING "prefix", "suffix", "current_value", "padding"
  `;

  const row = rows[0];
  if (!row) {
    throw new Error(`Failed to upsert NumberSequence for workspace ${workspaceId}, type ${type}`);
  }

  return {
    prefix: row.prefix,
    suffix: row.suffix,
    currentValue: row.current_value,
    padding: row.padding,
  };
}
