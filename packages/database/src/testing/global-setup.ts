import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { createPrisma } from '../client';
import { packageDatabaseUrl } from './test-database';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This package's own test database, when TEST_DATABASE_URL is set. */
    testDatabaseUrl: string | undefined;
  }
}

/**
 * Vitest globalSetup: copies the migrated TEST_DATABASE_URL database into
 * this package's own database before the suites run, and drops it after.
 * `setup.ts` points TEST_DATABASE_URL at the copy inside the workers.
 *
 * The copy is CREATE DATABASE ... TEMPLATE, so nothing may be connected to
 * the base database while it runs: point TEST_DATABASE_URL at a database
 * used only as the template (CI's service database is).
 */
export default async function setup(project: TestProject) {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    project.provide('testDatabaseUrl', undefined);
    return;
  }
  const { name } = JSON.parse(readFileSync(join(project.config.root, 'package.json'), 'utf8')) as {
    name: string;
  };
  const db = packageDatabaseUrl(base, name);
  const admin = createPrisma(db.adminUrl);
  const drop = () => admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db.name}" WITH (FORCE)`);
  try {
    await drop(); // left over from an interrupted run
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db.name}" TEMPLATE "${db.template}"`);
  } catch (error) {
    await admin.$disconnect();
    throw new Error(
      `Could not copy ${db.template} to ${db.name} for ${name}'s tests ` +
        `(is something else connected to ${db.template}?)`,
      { cause: error }
    );
  }
  project.provide('testDatabaseUrl', db.url);

  return async () => {
    try {
      await drop();
    } finally {
      await admin.$disconnect();
    }
  };
}
