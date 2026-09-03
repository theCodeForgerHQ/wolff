/**
 * Env for the seed scripts, imported first. Prisma's CLI reads the
 * monorepo's root `.env.local` and `.env` (prisma.config.ts); the seeds run
 * as plain `tsx` scripts, so they load the same files here, then this
 * package's own `.env` as before. A variable already set (CI, a shell
 * export) wins over every file.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { loadEnvFiles } from '../scripts/load-env';

loadEnvFiles(path.resolve(import.meta.dirname, '../../..'));
dotenv.config({ quiet: true });
