// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A webhook endpoint receives signed copies of the workspace's events
 * (clients, invoices, payments), so adding, redirecting or removing one is
 * an admin task, like the other workspace settings.
 */
const mocks = vi.hoisted(() => {
  const op = () => vi.fn().mockResolvedValue({ id: 'ep-1', workspaceId: 'ws-1' });
  return {
    workspace: vi.fn(),
    endpoint: { create: op(), update: op(), delete: op(), deleteMany: op(), findFirst: op() },
  };
});

vi.mock('@wolff/database', () => ({
  prisma: { webhookEndpoint: mocks.endpoint, webhookDelivery: { deleteMany: vi.fn() } },
  Prisma: { JsonNull: null },
}));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: mocks.workspace,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@wolff/core/encryption', () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));

import {
  createWebhookEndpoint,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
} from '@/lib/webhooks/actions';
import { createWebhook, updateWebhook, deleteWebhook } from '@/lib/settings/actions';

const URL_OK = 'https://hooks.example.com/x';

// [name, call, refused] where refused checks the action's own error style.
const CALLS: [string, () => Promise<unknown>, 'result' | 'throw'][] = [
  [
    'createWebhookEndpoint',
    () => createWebhookEndpoint({ url: URL_OK, events: ['invoice.paid'] }),
    'result',
  ],
  ['updateWebhookEndpoint', () => updateWebhookEndpoint('ep-1', { url: URL_OK }), 'result'],
  ['deleteWebhookEndpoint', () => deleteWebhookEndpoint('ep-1'), 'result'],
  [
    'createWebhook',
    () => createWebhook({ url: URL_OK, events: ['invoice.paid'] } as never),
    'throw',
  ],
  ['updateWebhook', () => updateWebhook({ id: 'ep-1', url: URL_OK } as never), 'throw'],
  ['deleteWebhook', () => deleteWebhook('ep-1'), 'throw'],
];

const writes = () =>
  mocks.endpoint.create.mock.calls.length +
  mocks.endpoint.update.mock.calls.length +
  mocks.endpoint.delete.mock.calls.length +
  mocks.endpoint.deleteMany.mock.calls.length;

describe('webhook endpoint management needs an admin', () => {
  beforeEach(() => vi.clearAllMocks());

  describe.each(['member', 'viewer'])('as %s', (role) => {
    it.each(CALLS)('%s is refused before any write', async (_name, call, style) => {
      mocks.workspace.mockResolvedValue({ workspaceId: 'ws-1', userId: 'u-1', role });
      if (style === 'throw') await expect(call()).rejects.toThrow(/admin/i);
      else
        expect(await call()).toMatchObject({
          success: false,
          error: expect.stringMatching(/admin/i),
        });
      expect(writes()).toBe(0);
    });
  });

  it('lets an admin add an endpoint', async () => {
    mocks.workspace.mockResolvedValue({ workspaceId: 'ws-1', userId: 'u-1', role: 'admin' });
    expect(await createWebhookEndpoint({ url: URL_OK, events: ['invoice.paid'] })).toMatchObject({
      success: true,
    });
    expect(mocks.endpoint.create).toHaveBeenCalled();
  });
});
