import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetCurrentUserWorkspace } = vi.hoisted(() => ({
  mockPrisma: { apiKey: { create: vi.fn(), findMany: vi.fn() } },
  mockGetCurrentUserWorkspace: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/workspace/get-current-workspace', () => ({
  getCurrentUserWorkspace: mockGetCurrentUserWorkspace,
}));
vi.mock('@wolff/database', () => ({ prisma: mockPrisma }));

import { generateApiKey } from '@/lib/api-keys/actions';

describe('generateApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUserWorkspace.mockResolvedValue({
      workspaceId: 'ws-1',
      userId: 'u-1',
      role: 'owner',
    });
    mockPrisma.apiKey.create.mockResolvedValue({ id: 'key-1' });
  });

  it('creates a publishable widget key limited to its scopes and origins', async () => {
    const result = await generateApiKey({
      name: 'Website',
      kind: 'publishable',
      allowedOrigins: ['https://shop.example.com', ' https://shop.example.com '],
    });

    expect(result.success).toBe(true);
    expect(result.key).toMatch(/_pk_/);
    expect(mockPrisma.apiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws-1',
        kind: 'publishable',
        scopes: ['lead:create', 'invoice:pay'],
        allowedOrigins: ['https://shop.example.com'],
      }),
    });
  });

  it('refuses a publishable key without a valid origin', async () => {
    for (const allowedOrigins of [[], ['shop.example.com'], ['http://shop.example.com']]) {
      const result = await generateApiKey({ name: 'Website', kind: 'publishable', allowedOrigins });
      expect(result.success).toBe(false);
    }
    expect(mockPrisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('keeps secret keys as they were: all legacy scopes, no origins', async () => {
    const result = await generateApiKey({ name: 'Zapier' });

    expect(result.key).toMatch(/^qc_sk_/);
    const data = mockPrisma.apiKey.create.mock.calls[0]![0].data;
    expect(data.kind ?? 'secret').toBe('secret');
    expect(data.allowedOrigins ?? []).toEqual([]);
  });
});
