import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Loads the monorepo's env files for the Prisma CLI. Precedence, highest
 * first: variables already in the environment (a shell export, CI), then
 * `.env.local`, then `.env`. dotenv never overrides a variable that is
 * already set, so the files are read in that order.
 */
export function loadEnvFiles(
  rootDir: string,
  env: Record<string, string | undefined> = process.env
): void {
  for (const file of ['.env.local', '.env']) {
    dotenv.config({
      path: path.join(rootDir, file),
      processEnv: env as dotenv.DotenvPopulateInput,
      quiet: true,
    });
  }
}
