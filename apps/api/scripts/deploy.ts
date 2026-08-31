/**
 * Deploys web, api and ai to Vercel production from a git ref, smoke-tests
 * each, and rolls back with `vercel rollback` when a test fails. Run through
 * scripts/deploy.sh, which builds the source archive. See docs/runbook.md.
 *
 *   tsx scripts/deploy.ts <archive dir> [api,ai,web]
 *
 * Env: VERCEL_TOKEN (or the Vercel CLI's own login), VERCEL_SCOPE,
 * VERCEL_TEAM_ID, VERCEL_PROJECT_{API,AI,WEB}, VERCEL_BYPASS_WEB (web is behind
 * Vercel Authentication; the smoke test needs its automation bypass).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { release, type ReleaseDeps, type ReleaseTarget } from '../src/deploy/release';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The Vercel CLI's stored login, when no VERCEL_TOKEN is given. */
function vercelToken(): string {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  const file =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Application Support/com.vercel.cli/auth.json')
      : join(homedir(), '.local/share/com.vercel.cli/auth.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { token: string }).token;
}

function run(args: string[], cwd: string, extraEnv: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('vercel', args, { cwd, env: { ...process.env, ...extraEnv } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`vercel ${args[0]} exited ${code}: ${err.trim().split('\n').pop()}`))
    );
  });
}

const [archive, only] = process.argv.slice(2);
if (!archive) {
  console.error('usage: deploy.ts <archive dir> [api,ai,web]');
  process.exit(2);
}

const token = vercelToken();
const teamId = env('VERCEL_TEAM_ID');
const scope = env('VERCEL_SCOPE');
const bypass = { 'x-vercel-protection-bypass': env('VERCEL_BYPASS_WEB') };

// api first (web and ai call it), then ai, then web.
const all: ReleaseTarget[] = [
  {
    name: 'api',
    projectId: env('VERCEL_PROJECT_API'),
    dir: archive,
    productionUrl: 'https://wolff-api.vercel.app',
    smoke: [
      { path: '/healthz', status: 200, contains: '"ok"' },
      { path: '/readyz', status: 200, contains: '"database":"up"' },
    ],
  },
  {
    name: 'ai',
    projectId: env('VERCEL_PROJECT_AI'),
    // Deployed from services/ai alone; see docs/free-tier.md.
    dir: join(archive, 'services/ai'),
    productionUrl: 'https://wolff-ai.vercel.app',
    smoke: [
      { path: '/healthz', status: 200, contains: '"service":"ai"' },
      { path: '/healthz', method: 'HEAD', status: 200 },
    ],
  },
  {
    name: 'web',
    projectId: env('VERCEL_PROJECT_WEB'),
    dir: archive,
    productionUrl: 'https://wolff-web.vercel.app',
    smoke: [{ path: '/login', status: 200, headers: bypass }],
  },
];
const wanted = only ? only.split(',') : all.map((t) => t.name);
const targets = all.filter((t) => wanted.includes(t.name));

const project = (t: ReleaseTarget) => ({ VERCEL_ORG_ID: teamId, VERCEL_PROJECT_ID: t.projectId });

const deps: ReleaseDeps = {
  async currentProduction(t) {
    const host = new URL(t.productionUrl).host;
    const response = await fetch(`https://api.vercel.com/v4/aliases/${host}?teamId=${teamId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`alias lookup for ${host}: ${response.status}`);
    const body = (await response.json()) as { deployment?: { url?: string } };
    return body.deployment?.url ? `https://${body.deployment.url}` : undefined;
  },
  deploy: (t) =>
    run(['deploy', '--prod', '--yes', '--scope', scope], t.dir, project(t)).then(
      (out) =>
        out
          .split('\n')
          .filter((line) => line.startsWith('https://'))
          .pop() ?? out
    ),
  promote: (t, url) =>
    run(['promote', url, '--yes', '--scope', scope], t.dir, project(t)).then(() => undefined),
  rollback: (t, to) =>
    run(['rollback', to, '--yes', '--scope', scope], t.dir, project(t)).then(() => undefined),
  async request(url, init) {
    const response = await fetch(url, { ...init, redirect: 'manual' });
    return { status: response.status, body: init.method === 'HEAD' ? '' : await response.text() };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
  now: () => Date.now(),
};

release(targets, deps).then(
  (result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
