import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { QStashDispatcher, createQStashVerifier } from './qstash';
import type { Job } from './types';

const CURRENT = 'sig_current_key_for_tests';
const NEXT = 'sig_next_key_for_tests';
const URL = 'https://api.example.test/jobs/run/email.send';
const body = JSON.stringify({
  type: 'email.send',
  payload: { scheduledEmailId: 'a', workspaceId: 'b' },
});

/** A signature as QStash produces it: an HS256 JWT over the URL and the body hash. */
async function sign(
  overrides: { key?: string; url?: string; body?: string; exp?: number; iss?: string } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    body: createHash('sha256')
      .update(overrides.body ?? body)
      .digest('base64url'),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(overrides.iss ?? 'Upstash')
    .setSubject(overrides.url ?? URL)
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(overrides.exp ?? now + 300)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(overrides.key ?? CURRENT));
}

describe('QStash signature verification', () => {
  const verify = createQStashVerifier({ currentSigningKey: CURRENT, nextSigningKey: NEXT });

  it('accepts a request signed with the current key', async () => {
    expect(await verify({ signature: await sign(), body, url: URL })).toBe(true);
  });

  it('accepts the next key, so keys can be rotated', async () => {
    expect(await verify({ signature: await sign({ key: NEXT }), body, url: URL })).toBe(true);
  });

  it.each([
    ['a missing signature', async () => ({ signature: undefined, body, url: URL })],
    ['an empty signature', async () => ({ signature: '', body, url: URL })],
    ['a signature that is not a JWT', async () => ({ signature: 'abc.def', body, url: URL })],
    [
      'another key',
      async () => ({ signature: await sign({ key: 'someone-else' }), body, url: URL }),
    ],
    ['a changed body', async () => ({ signature: await sign(), body: `${body} `, url: URL })],
    [
      'a signature for another URL',
      async () => ({
        signature: await sign({ url: 'https://evil.example/jobs/run/email.send' }),
        body,
        url: URL,
      }),
    ],
    [
      'an expired signature',
      async () => ({
        signature: await sign({ exp: Math.floor(Date.now() / 1000) - 60 }),
        body,
        url: URL,
      }),
    ],
    ['another issuer', async () => ({ signature: await sign({ iss: 'Mallory' }), body, url: URL })],
  ])('rejects %s', async (_name, build) => {
    expect(await verify(await build())).toBe(false);
  });

  it('keeps using the configured keys when QSTASH_DEV is set in the environment', async () => {
    // The SDK's dev mode swaps in the publicly known keys of its local dev
    // server. An environment variable must not be able to switch that on.
    process.env.QSTASH_DEV = 'true';
    try {
      const inDevEnv = createQStashVerifier({ currentSigningKey: CURRENT, nextSigningKey: NEXT });

      expect(await inDevEnv({ signature: await sign(), body, url: URL })).toBe(true);
      expect(
        await inDevEnv({ signature: await sign({ key: 'someone-else' }), body, url: URL })
      ).toBe(false);
    } finally {
      delete process.env.QSTASH_DEV;
    }
  });

  it('cannot be built without signing keys', () => {
    expect(() => createQStashVerifier({ currentSigningKey: '', nextSigningKey: NEXT })).toThrow();
    expect(() =>
      createQStashVerifier({ currentSigningKey: CURRENT, nextSigningKey: '' })
    ).toThrow();
  });
});

describe('QStashDispatcher', () => {
  it("publishes the job to the API's run endpoint for its type, deduplicated by job id", async () => {
    const published: unknown[] = [];
    const dispatcher = new QStashDispatcher({
      client: { publishJSON: async (request) => void published.push(request) },
      apiUrl: 'https://api.example.test/',
    });
    const job: Job = {
      type: 'email.send',
      payload: { scheduledEmailId: 'a', workspaceId: 'b' },
      jobId: 'outbox:123',
      outboxEventId: '123',
    };

    await dispatcher.dispatch(job);

    expect(published).toEqual([
      {
        url: 'https://api.example.test/jobs/run/email.send',
        body: job,
        deduplicationId: 'outbox-123',
        retries: 3,
      },
    ]);
  });

  it('asks QStash to deliver a delayed job later, in whole seconds', async () => {
    const published: { delay?: number }[] = [];
    const dispatcher = new QStashDispatcher({
      client: { publishJSON: async (request) => void published.push(request) },
      apiUrl: 'https://api.example.test',
    });

    await dispatcher.dispatch({
      type: 'automations.tick',
      payload: { runId: 'r' },
      jobId: 'automation:r:0:wake',
      delayMs: 1_500,
    });

    expect(published[0]!.delay).toBe(2);
  });
});

describe('QStashDispatcher timeout', () => {
  // The outbox relay publishes inside a transaction that holds row locks; a
  // QStash API that hangs must not hold them (and the function) for long.
  it('gives up on a publish that does not answer in time', async () => {
    const dispatcher = new QStashDispatcher({
      client: { publishJSON: () => new Promise(() => {}) },
      apiUrl: 'https://api.example.test',
      timeoutMs: 50,
    });
    const started = Date.now();
    await expect(
      dispatcher.dispatch({ type: 'outbox.sweep', payload: {}, jobId: 'j-1' })
    ).rejects.toThrow(/did not accept/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
