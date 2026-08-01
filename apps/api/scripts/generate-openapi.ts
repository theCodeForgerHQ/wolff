import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateOpenAPIDocument } from '../src/openapi/document';

const out = resolve(process.cwd(), 'openapi.json');
const doc = generateOpenAPIDocument({
  title: 'Wolff API',
  version: process.env.npm_package_version ?? '0.1.0',
  description:
    'Quote-to-cash API for agencies and freelancers. Public routes require a workspace API key passed in the Authorization header as `Bearer qc_sk_...`.',
  serverUrl: process.env.PUBLIC_API_URL ?? 'http://localhost:4000',
});

writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`Wrote ${out}`);
