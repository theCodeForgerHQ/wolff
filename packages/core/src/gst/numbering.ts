import type { DbOrTx } from '../context';
import { getFinancialYear } from './financial-year';

const SERIAL_CHARSET = /^[A-Za-z0-9/-]+$/;
const MAX_SERIAL_LENGTH = 16;

export interface NextNumberInput {
  workspaceId: string;
  type: string;
  date?: Date;
  prefix?: string;
  suffix?: string;
  padding?: number;
}

export interface NextNumberResult {
  serialNumber: string;
  financialYear: string | null;
}

/**
 * Generates the next serial number for a workspace and document type. For
 * GST workspaces a financial-year row is used; for non-GST workspaces the
 * row with no financial year is used.
 */
export async function nextSerialNumber(
  db: DbOrTx,
  input: NextNumberInput
): Promise<NextNumberResult> {
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: input.workspaceId },
    include: { businessProfile: true },
  });

  const isGstWorkspace = Boolean(workspace.businessProfile?.gstin);
  const financialYear = isGstWorkspace ? getFinancialYear(input.date) : null;

  const prefix = (input.prefix ?? '').replace(/-$/, '');
  const suffix = input.suffix ?? '';
  const padding = input.padding ?? 4;

  return db.$transaction(async (tx) => {
    const [existing] =
      financialYear === null
        ? await tx.$queryRaw<Array<{ id: string; current_value: number }>>`
          SELECT id, current_value FROM number_sequences
          WHERE workspace_id = ${input.workspaceId}
            AND type = ${input.type}
            AND financial_year IS NULL
          FOR UPDATE`
        : await tx.$queryRaw<Array<{ id: string; current_value: number }>>`
          SELECT id, current_value FROM number_sequences
          WHERE workspace_id = ${input.workspaceId}
            AND type = ${input.type}
            AND financial_year = ${financialYear}
          FOR UPDATE`;

    let currentValue: number;
    if (existing) {
      const updated = await tx.numberSequence.update({
        where: { id: existing.id, workspaceId: input.workspaceId },
        data: { currentValue: { increment: 1 } },
      });
      currentValue = updated.currentValue;
    } else {
      const created = await tx.numberSequence.create({
        data: {
          workspaceId: input.workspaceId,
          type: input.type,
          financialYear,
          prefix: input.prefix,
          suffix: input.suffix,
          currentValue: 1,
          padding,
        },
      });
      currentValue = created.currentValue;
    }

    const parts = [prefix, String(currentValue).padStart(padding, '0')];
    if (suffix) parts.push(suffix);
    const serialNumber = parts.filter(Boolean).join('-');

    if (serialNumber.length > MAX_SERIAL_LENGTH) {
      throw new Error(`Serial number exceeds ${MAX_SERIAL_LENGTH} characters`);
    }
    if (prefix && !SERIAL_CHARSET.test(prefix)) {
      throw new Error('Serial prefix contains invalid characters');
    }

    return { serialNumber, financialYear };
  });
}

/**
 * Validates that a serial number conforms to GST rules.
 */
export function validateSerialNumber(serialNumber: string): void {
  if (serialNumber.length > MAX_SERIAL_LENGTH) {
    throw new Error(`Serial number must be ≤ ${MAX_SERIAL_LENGTH} characters`);
  }
  if (!SERIAL_CHARSET.test(serialNumber)) {
    throw new Error('Serial number contains invalid characters');
  }
}
