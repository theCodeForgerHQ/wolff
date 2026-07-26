import { prisma, withTenantGuard } from '@wolff/database';

/**
 * The client handed to packages/core: the app's Prisma client behind the
 * tenant guard. Code that still queries `prisma` directly is not guarded; it
 * moves behind this as it moves into core.
 */
export const coreDb = withTenantGuard(prisma);
