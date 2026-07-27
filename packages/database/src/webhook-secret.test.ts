import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma } from './client';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('webhook_endpoints.secret (Postgres)', () => {
  const db = createPrisma(url);
  let workspaceId = '';

  afterAll(async () => {
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
    await db.$disconnect();
  });

  it('holds the ciphertext of a signing secret, which is longer than 100 characters', async () => {
    // enc:<iv 16>:<tag 24>:<54 bytes as base64, 72> = 118 characters.
    const ciphertext = `enc:${'i'.repeat(16)}:${'t'.repeat(24)}:${'c'.repeat(72)}`;
    const workspace = await db.workspace.create({
      data: { name: 'Secret Length', slug: `secret-length-${randomUUID()}` },
    });
    workspaceId = workspace.id;

    const endpoint = await db.webhookEndpoint.create({
      data: { workspaceId, url: 'https://hooks.example.com/in', secret: ciphertext },
    });

    expect(ciphertext).toHaveLength(118);
    expect(endpoint.secret).toBe(ciphertext);
  });
});
