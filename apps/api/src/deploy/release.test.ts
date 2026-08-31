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
function fakeVercel(
  options: { broken?: string[]; deployFails?: string[]; autoAssignOff?: boolean } = {}
) {
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
      // After a rollback Vercel stops assigning the production domain on deploy.
      if (!options.autoAssignOff) prod.set(t.name, url);
      return url;
    },
    promote: async (t, url) => {
      calls.push(`promote ${t.name}`);
      prod.set(t.name, url);
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

  it('promotes the new deployment when Vercel did not (auto-assign off after a rollback)', async () => {
    const { deps, calls, prod } = fakeVercel({ autoAssignOff: true });
    const result = await release([target('api')], deps);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['deploy api', 'promote api']);
    expect(prod.get('api')).toBe('https://api-new.example.test');
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

  it('rolls back when promote throws, including the project whose promote failed', async () => {
    const { deps, calls, prod } = fakeVercel({ autoAssignOff: true });
    deps.promote = async (t) => {
      calls.push(`promote ${t.name}`);
      if (t.name === 'web') throw new Error('promote refused');
      prod.set(t.name, `https://${t.name}-new.example.test`);
    };
    const result = await release([target('api'), target('web')], deps);

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual({ name: 'web', reason: 'promote failed: promote refused' });
    expect(calls).toEqual([
      'deploy api',
      'promote api',
      'deploy web',
      'promote web',
      'rollback web https://web-old.example.test',
      'rollback api https://api-old.example.test',
    ]);
    expect(prod.get('api')).toBe('https://api-old.example.test');
  });

  it('rolls back the earlier projects when the production alias lookup throws', async () => {
    const { deps, calls } = fakeVercel();
    const lookup = deps.currentProduction;
    deps.currentProduction = async (t) => {
      if (t.name === 'web') throw new Error('alias lookup for web: 500');
      return lookup(t);
    };
    const result = await release([target('api'), target('web')], deps);

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual({
      name: 'web',
      reason: 'alias lookup failed: alias lookup for web: 500',
    });
    expect(calls).toEqual(['deploy api', 'rollback api https://api-old.example.test']);
  });

  it('keeps rolling back the other projects when one rollback throws', async () => {
    const { deps, calls, prod } = fakeVercel({ broken: ['web'] });
    const rollback = deps.rollback;
    deps.rollback = async (t, to) => {
      if (t.name === 'ai') {
        calls.push(`rollback ${t.name} ${to}`);
        throw new Error('rollback refused');
      }
      return rollback(t, to);
    };
    const result = await release([target('api'), target('ai'), target('web')], deps);

    expect(calls).toEqual([
      'deploy api',
      'deploy ai',
      'deploy web',
      'rollback web https://web-old.example.test',
      'rollback ai https://ai-old.example.test',
      'rollback api https://api-old.example.test',
    ]);
    expect(prod.get('api')).toBe('https://api-old.example.test');
    expect(result.rolledBack).toEqual(['web', 'api']);
    expect(result.rollbackFailed).toEqual([{ name: 'ai', reason: 'rollback refused' }]);
    expect(result.recovered).toBe(false);
  });

  it('fails and rolls back when promote returns but production still points elsewhere', async () => {
    const { deps, calls, prod } = fakeVercel({ autoAssignOff: true });
    deps.promote = async (t) => {
      calls.push(`promote ${t.name}`); // reports success, alias unchanged
    };
    const result = await release([target('api')], deps);

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual({
      name: 'api',
      reason:
        'production alias points at https://api-old.example.test, expected https://api-new.example.test',
    });
    expect(calls).toEqual([
      'deploy api',
      'promote api',
      'rollback api https://api-old.example.test',
    ]);
    expect(prod.get('api')).toBe('https://api-old.example.test');
  });
});
