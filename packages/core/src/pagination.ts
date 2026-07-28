/**
 * Cursor pagination over (createdAt desc, id desc). The cursor is opaque to
 * clients: base64url of the last row's position.
 */
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.createdAt.toISOString(), position.id])).toString(
    'base64url'
  );
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
      throw new InvalidCursorError();
    }
    const createdAt = new Date(parsed[0]);
    if (Number.isNaN(createdAt.getTime())) throw new InvalidCursorError();
    return { createdAt, id: parsed[1] };
  } catch {
    throw new InvalidCursorError();
  }
}

/** The `where` fragment for "rows after this cursor" in (createdAt desc, id desc) order. */
export function afterCursor(cursor: string | undefined) {
  if (!cursor) return {};
  const { createdAt, id } = decodeCursor(cursor);
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
}

/** Turns `limit + 1` fetched rows into a page and its meta. */
export function toCursorPage<T extends CursorPosition>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, meta: { hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null } };
}
