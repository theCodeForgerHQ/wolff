// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A workspace's webhook URL is user input. It must not let the server call
 * itself or its network: loopback, link-local (cloud metadata), private
 * ranges, or a host name that resolves to one.
 */
const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryUpdate: vi.fn(),
  endpointCreate: vi.fn(),
  endpointFindFirst: vi.fn(),
  endpointUpdate: vi.fn(),
}));

vi.mock('@wolff/database', () => ({
  prisma: {
    webhookDelivery: { create: mocks.deliveryCreate, update: mocks.deliveryUpdate },
    webhookEndpoint: {
      create: mocks.endpointCreate,
      findFirst: mocks.endpointFindFirst,
      update: mocks.endpointUpdate,
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
  Prisma: { JsonNull: null },
}));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: mocks.workspace,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The emitter imports outbound.ts to register its listeners; only delivery is under test.
vi.mock('@/lib/events/emitter', () => ({ domainEvents: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('@wolff/core/encryption', () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));

import { deliverToEndpoint } from '@/lib/webhooks/outbound';
import { createWebhookEndpoint, updateWebhookEndpoint } from '@/lib/webhooks/actions';
import { createWebhook, updateWebhook } from '@/lib/settings/actions';

const PRIVATE_URLS = [
  'http://127.0.0.1:8080/hook',
  'http://localhost:3000/hook',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.5/hook',
  'http://[::1]/hook',
];

let server: Server;
let hits = 0;
let localUrl = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.end('internal secret');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  localUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  hits = 0;
  mocks.workspace.mockResolvedValue({ workspaceId: 'ws-1', userId: 'u-1', role: 'owner' });
  mocks.deliveryCreate.mockResolvedValue({ id: 'del-1' });
  mocks.deliveryUpdate.mockResolvedValue({});
  mocks.endpointFindFirst.mockResolvedValue({ id: 'ep-1', workspaceId: 'ws-1' });
});

describe('outbound webhook delivery', () => {
  it('never sends a request to a private address, and does not retry it', async () => {
    await deliverToEndpoint('ws-1', 'ep-1', localUrl, 'secret', {
      type: 'invoice.paid',
      payload: { workspaceId: 'ws-1' },
    } as never);

    expect(hits).toBe(0);
    const last = mocks.deliveryUpdate.mock.calls.at(-1)![0];
    expect(last.data.status).toBe('failed');
    expect(mocks.deliveryUpdate.mock.calls.map((c) => c[0].data.response).join(' ')).toMatch(
      /private address/
    );
  });
});

describe('saving a webhook URL', () => {
  it.each(PRIVATE_URLS)('createWebhookEndpoint refuses %s', async (url) => {
    const result = await createWebhookEndpoint({ url, events: ['invoice.paid'] });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/private/) });
    expect(mocks.endpointCreate).not.toHaveBeenCalled();
  });

  it.each(PRIVATE_URLS)('updateWebhookEndpoint refuses %s', async (url) => {
    const result = await updateWebhookEndpoint('ep-1', { url });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/private/) });
    expect(mocks.endpointUpdate).not.toHaveBeenCalled();
  });

  it.each(PRIVATE_URLS)('settings createWebhook refuses %s', async (url) => {
    await expect(createWebhook({ url, events: ['invoice.paid'] } as never)).rejects.toThrow(
      /private/
    );
    expect(mocks.endpointCreate).not.toHaveBeenCalled();
  });

  it.each(PRIVATE_URLS)('settings updateWebhook refuses %s', async (url) => {
    await expect(updateWebhook({ id: 'ep-1', url } as never)).rejects.toThrow(/private/);
    expect(mocks.endpointUpdate).not.toHaveBeenCalled();
  });

  it('still accepts a public https URL', async () => {
    mocks.endpointCreate.mockResolvedValue({ id: 'ep-2', url: 'https://hooks.example.com/x' });
    const result = await createWebhookEndpoint({
      url: 'https://hooks.example.com/x',
      events: ['invoice.paid'],
    });
    expect(result).toMatchObject({ success: true });
  });
});
