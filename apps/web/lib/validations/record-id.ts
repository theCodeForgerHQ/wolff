/**
 * True for a string shaped like a record id: a UUID, or the readable ids the
 * demo data is seeded with ("demo-invoice-1"). Detail pages check this before
 * querying, so junk in the URL is a 404 and never reaches the database. It
 * used to accept UUIDs only, which made every seeded demo record a 404.
 */
export function isRecordId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}
