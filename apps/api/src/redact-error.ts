/**
 * What may leave the process about an error. Prisma puts the whole query in
 * its messages, values included (names, emails, amounts, tokens), so a
 * Prisma error is reduced to its class, Prisma code, model and operation.
 * Other errors pass through unchanged.
 */
export interface ReportableError {
  error: unknown;
  /** Groups events in Sentry; absent for errors Sentry should group itself. */
  fingerprint?: string[];
}

const PRISMA_CALL = /`(?:\w+\.)?(\w+)\.(\w+)\(\)`/;

export function redactError(error: unknown): ReportableError {
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name !== 'string' || !name.startsWith('PrismaClient')) return { error };
  const message = String((error as { message?: unknown }).message ?? '');
  const call = PRISMA_CALL.exec(message);
  const operation = call ? `${call[1]}.${call[2]}` : 'unknown';
  const code = (error as { code?: unknown }).code;
  const safe = new Error(
    `${name}${typeof code === 'string' ? ` ${code}` : ''} in ${operation} (message withheld)`
  );
  safe.name = name;
  safe.stack = `${safe.name}: ${safe.message}`;
  return { error: safe, fingerprint: [name, operation] };
}
