import { inject } from 'vitest';

// Runs in each worker before the test files are imported: the suites read
// TEST_DATABASE_URL at module load (see global-setup.ts).
const url = inject('testDatabaseUrl');
if (url) process.env.TEST_DATABASE_URL = url;
