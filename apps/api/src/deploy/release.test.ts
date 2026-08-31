import { describe, expect, it } from 'vitest';
import { release, SMOKE_ATTEMPTS, type ReleaseDeps, type ReleaseTarget } from './release';

const target = (name: string): ReleaseTarget => ({
  name,
  projectId: `prj_${name}`,
  dir: '.',
  productionUrl: `https://${name}.example.test`,
  smoke: [{ path: '/readyz', status: 200, contains: 'ready' }],
});

/** Fake Vercel: production per project, deploys that can be broken. */
function fakeVercel(options: { broken?: string[]; deployFails?: string[] } = {}) {
  const prod = new Map<string, string>([
    ['api', 'https://api-old.example.test'],
    ['ai', 'https://ai-old.example.test'],
    ['web', 'https://web-old.example.test'],
  ]);
  const calls: string[] = [];
  let clock = 0;
  const deps: ReleaseDeps = {
    currentProduction: async (t) => prod.get(t.name),
    deploy: async (t) => {
      calls.push(`deploy ${t.name}`);
      if (options.deployFails?.includes(t.name)) throw new Error('build failed');
      const url = `https://${t.name}-new.example.test`;
      prod.set(t.name, url);
      return url;
    },
    rollback: async (t, to) => {
      calls.push(`rollback ${t.name} ${to}`);
      prod.set(t.name, to);
    },
    request: async (url) => {
      const name = new URL(url).hostname.split('.')[0]!;
      const live = prod.get(name)!;
      const broken = live.includes('-new') && options.broken?.includes(name);
      return broken
        ? { status: 500, body: '{"status":"broken"}' }
        : { status: 200, body: '{"status":"ready"}' };
    },
    sleep: async () => {
      clock += 5_000;
    },
    log: () => undefined,
    now: () => clock,
  };
  return { deps, calls, prod };
}

describe('release', () => {
  it('deploys every project in order and keeps them when the smoke tests pass', async () => {
    const { deps, calls, prod } = fakeVercel();
    const result = await release([target('api'), target('ai'), target('web')], deps);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['deploy api', 'deploy ai', 'deploy web']);
    expect(prod.get('web')).toBe('https://web-new.example.test');
    expect(result.rolledBack).toEqual([]);
  });

  it('rolls back every project it deployed, newest first, when one fails its smoke test', async () => {
    const { deps, calls, prod } = fakeVercel({ broken: ['ai'] });
    const result = await release([target('api'), target('ai'), target('web')], deps);

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual({
      name: 'ai',
      reason: 'GET /readyz answered 500, expected 200',
    });
    expect(calls).toEqual([
      'deploy api',
      'deploy ai',
      'rollback ai https://ai-old.example.test',
      'rollback api https://api-old.example.test',
    ]);
    expect(prod.get('api')).toBe('https://api-old.example.test');
    expect(result.recovered).toBe(true);
  });

  it('retries a smoke check before giving up (cold starts)', async () => {
    const { deps } = fakeVercel();
    let tries = 0;
    const request = deps.request;
    deps.request = async (url, init) => {
      tries++;
      return tries < SMOKE_ATTEMPTS ? { status: 503, body: '' } : request(url, init);
    };

    expect((await release([target('api')], deps)).ok).toBe(true);
    expect(tries).toBe(SMOKE_ATTEMPTS);
  });

  it('fails a check whose body lacks the expected text, and on a network error', async () => {
    const { deps } = fakeVercel();
    deps.request = async () => ({ status: 200, body: 'Vercel login page' });
    expect((await release([target('api')], deps)).failed?.reason).toMatch(/body lacks/);

    deps.request = async () => {
      throw new Error('ECONNRESET');
    };
    expect((await release([target('api')], deps)).failed?.reason).toMatch(/ECONNRESET/);
  });

  it('rolls back the earlier projects when a later deploy itself fails', async () => {
    const { deps, calls } = fakeVercel({ deployFails: ['web'] });
    const result = await release([target('api'), target('web')], deps);

    expect(result.failed?.reason).toMatch(/deploy failed: build failed/);
    expect(calls).toEqual([
      'deploy api',
      'deploy web',
      'rollback api https://api-old.example.test',
    ]);
  });

  it('reports a rollback that did not bring the project back', async () => {
    const { deps } = fakeVercel({ broken: ['api'] });
    deps.rollback = async () => undefined; // the rollback silently did nothing
    const result = await release([target('api')], deps);

    expect(result.rolledBack).toEqual(['api']);
    expect(result.recovered).toBe(false);
  });
});
