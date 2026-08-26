import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrisma } from '@wolff/database';
import { runParityScenario } from '../src/testing/parity/runner';
import { seedParityData, clearParityData } from '../src/testing/parity/seed';

/**
 * Records the Next `/api/v1` responses the parity test compares the API with.
 *
 * Start the web app against a scratch database, with the Resend client
 * pointed at the stub this script serves (the send routes answer 502 when no
 * email goes out), then run this with the same DATABASE_URL:
 *
 *   RESEND_API_KEY=re_parity RESEND_BASE_URL=http://127.0.0.1:4599 \
 *     NEXT_PUBLIC_APP_URL=https://app.example.test pnpm exec next start -p 3101
 *   NEXT_URL=http://127.0.0.1:3101 pnpm exec tsx scripts/record-parity.ts
 *
 * The output, `src/routes/v1/__parity__/next-api-v1.json`, is committed.
 * Re-record only when the Next routes change, and read the diff.
 */
const nextUrl = process.env.NEXT_URL;
if (!nextUrl) throw new Error('NEXT_URL is required');
const out = resolve(process.cwd(), 'src/routes/v1/__parity__/next-api-v1.json');

const sent: unknown[] = [];
const resend = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    sent.push(JSON.parse(body || 'null'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `email_${sent.length}` }));
  });
});

async function main() {
  await new Promise<void>((done) => resend.listen(4599, '127.0.0.1', done));
  const db = createPrisma(process.env.DATABASE_URL);
  try {
    await seedParityData(db);
    const responses = await runParityScenario(nextUrl!, '/api/v1');
    writeFileSync(out, JSON.stringify(responses, null, 2) + '\n');
    console.log(`Recorded ${responses.length} responses (${sent.length} emails) to ${out}`);
  } finally {
    await clearParityData(db);
    await db.$disconnect();
    resend.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
