// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma } from '@wolff/database';
import { unlinkDemoIdentities } from '@/lib/demo/unlink-identities';

/**
 * Before 3aeba03 a Google sign-in from a browser holding the demo session
 * linked that Google identity to the shared demo user, a standing login to
 * it. The daily reset must remove such links, and only the demo user's.
 * Runs against TEST_DATABASE_URL with its own random emails.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('unlinkDemoIdentities (Postgres)', () => {
  const prisma = createPrisma(url);
  const run = randomUUID();
  const demoEmail = `demo-${run}@wolff.test`;
  const otherEmail = `owner-${run}@wolff.test`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [demoEmail, otherEmail] } } });
    await prisma.$disconnect();
  });

  it("deletes the demo user's linked identities and leaves everyone else's", async () => {
    const demo = await prisma.user.create({ data: { email: demoEmail } });
    const other = await prisma.user.create({ data: { email: otherEmail } });
    for (const [userId, id] of [
      [demo.id, `g-demo-${run}`],
      [demo.id, `gh-demo-${run}`],
      [other.id, `g-owner-${run}`],
    ] as const) {
      await prisma.account.create({
        data: { userId, type: 'oidc', provider: 'google', providerAccountId: id },
      });
    }

    expect(await unlinkDemoIdentities(prisma, demoEmail)).toBe(2);

    expect(await prisma.account.count({ where: { userId: demo.id } })).toBe(0);
    expect(await prisma.account.count({ where: { userId: other.id } })).toBe(1);
    expect(await prisma.user.count({ where: { id: { in: [demo.id, other.id] } } })).toBe(2);
  });
});
