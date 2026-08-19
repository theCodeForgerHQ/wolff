// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { jwtVerify, decodeProtectedHeader } from 'jose';
import { mintAssistantToken, scopesForRole } from '@/lib/assistant/service-token';

const SECRET = 'w'.repeat(64);

describe('assistant service token', () => {
  it('mints a 60 s web token for the AI service with the user and workspace', async () => {
    const token = await mintAssistantToken({
      secret: SECRET,
      userId: 'u1',
      workspaceId: 'ws1',
      role: 'editor',
    });
    expect(decodeProtectedHeader(token).kid).toBe('web');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      issuer: 'web',
      audience: 'ai',
    });
    expect(payload).toMatchObject({ sub: 'u1', workspaceId: 'ws1' });
    expect(payload.scopes).toEqual(scopesForRole('editor'));
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(typeof payload.jti).toBe('string');
  });

  it('gives viewers the assistant but not drafting', () => {
    expect(scopesForRole('viewer')).toContain('ai:use');
    expect(scopesForRole('viewer')).not.toContain('quotes:write');
    for (const role of ['owner', 'admin', 'editor'] as const) {
      expect(scopesForRole(role)).toEqual(expect.arrayContaining(['ai:use', 'quotes:write']));
    }
  });

  it('refuses to mint without a secret', async () => {
    await expect(
      mintAssistantToken({ secret: '', userId: 'u', workspaceId: 'w', role: 'owner' })
    ).rejects.toThrow('SVC_JWT_SECRET_WEB');
  });
});
