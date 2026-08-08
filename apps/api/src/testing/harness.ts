import { randomUUID } from 'node:crypto';
import { createPrisma, withTenantGuard } from '@wolff/database';
import type { Db } from '@wolff/core/context';
import { hashApiKey } from '@wolff/core/auth/api-keys';
import { createApp, type AppDeps } from '../app';
import { loadConfig, type ApiConfig } from '../config';

/** Shared setup for the API's tests: a guarded client, config and workspaces with keys. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const testConfig = (overrides: Record<string, string | undefined> = {}): ApiConfig =>
  loadConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'https://app.example.test',
    PUBLIC_API_URL: 'https://api.example.test',
    APP_URL: 'https://app.example.test',
    ...overrides,
  });

export function testDb() {
  const base = createPrisma(TEST_DATABASE_URL);
  const db: Db = withTenantGuard(base, { mode: 'throw' });
  return { base, db };
}

export function testApp(db: Db, deps: Partial<AppDeps> = {}) {
  return createApp({ db, config: testConfig(), ...deps });
}

export interface TestWorkspace {
  id: string;
  /** A secret key with every scope, as `Authorization: Bearer <key>`. */
  key: string;
  keyId: string;
}

export async function createTestWorkspace(
  base: ReturnType<typeof testDb>['base'],
  name: string,
  scopes: string[]
): Promise<TestWorkspace> {
  const run = randomUUID();
  const key = `qc_sk_${run.replace(/-/g, '')}`;
  const workspace = await base.workspace.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${run}`,
      apiKeys: {
        create: { name: 'test', keyHash: hashApiKey(key), keyPrefix: key.slice(0, 10), scopes },
      },
    },
    include: { apiKeys: true },
  });
  return { id: workspace.id, key, keyId: workspace.apiKeys[0]!.id };
}

export async function issueKey(
  base: ReturnType<typeof testDb>['base'],
  workspaceId: string,
  data: {
    scopes?: string[];
    kind?: 'secret' | 'publishable';
    rateLimitPerMin?: number;
    prefix?: string;
    allowedOrigins?: string[];
  }
): Promise<{ key: string; id: string }> {
  const key = `${data.prefix ?? 'qc_sk_'}${randomUUID().replace(/-/g, '')}`;
  const row = await base.apiKey.create({
    data: {
      workspaceId,
      name: 'test',
      keyHash: hashApiKey(key),
      keyPrefix: key.slice(0, 10),
      scopes: data.scopes ?? [],
      kind: data.kind ?? 'secret',
      rateLimitPerMin: data.rateLimitPerMin ?? 120,
      allowedOrigins: data.allowedOrigins,
    },
  });
  return { key, id: row.id };
}
