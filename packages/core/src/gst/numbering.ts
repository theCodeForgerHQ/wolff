import { incrementNumberSequence } from '@wolff/database';
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

  if (prefix && !SERIAL_CHARSET.test(prefix)) {
    throw new Error('Serial prefix contains invalid characters');
  }
  if (suffix && !SERIAL_CHARSET.test(suffix)) {
    throw new Error('Serial suffix contains invalid characters');
  }

  // One INSERT ... ON CONFLICT DO UPDATE: the first request of a year creates
  // the row and concurrent ones increment it, instead of racing to create it.
  // A number that turns out too long throws, which rolls the increment back.
  return db.$transaction(async (tx) => {
    const sequence = await incrementNumberSequence(
      tx as unknown as Parameters<typeof incrementNumberSequence>[0],
      input.workspaceId,
      input.type,
      financialYear,
      { prefix: input.prefix ?? '', currentValue: 1, padding }
    );

    const parts = [prefix, String(sequence.currentValue).padStart(padding, '0')];
    if (suffix) parts.push(suffix);
    const serialNumber = parts.filter(Boolean).join('-');

    if (serialNumber.length > MAX_SERIAL_LENGTH) {
      throw new Error(`Serial number exceeds ${MAX_SERIAL_LENGTH} characters`);
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
