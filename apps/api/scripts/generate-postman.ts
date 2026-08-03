import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const specPath = resolve(process.cwd(), 'openapi.json');
const outPath = resolve(process.cwd(), '../../docs/api/postman_collection.json');

// Generate the raw collection with openapi-to-postmanv2.
execSync(`npx openapi-to-postmanv2 -s ${specPath} -o ${outPath} -p`, {
  stdio: 'inherit',
});

const collection = JSON.parse(readFileSync(outPath, 'utf-8'));

function deterministicUuid(path: string[]): string {
  const hash = createHash('sha256').update(path.join('/')).digest('hex');
  // UUID v4 shape: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y is 8/9/a/b.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function normalize(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalize(item, [...path, String(index)]));
  }

  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const childPath = [...path, key];
      const isIdField = key === 'id' || key === '_postman_id';
      if (isIdField && typeof (value as Record<string, unknown>)[key] === 'string') {
        sorted[key] = deterministicUuid(childPath);
      } else {
        sorted[key] = normalize((value as Record<string, unknown>)[key], childPath);
      }
    }
    return sorted;
  }

  return value;
}

const normalized = normalize(collection);
writeFileSync(outPath, JSON.stringify(normalized, null, 2) + '\n');
console.log(`Wrote normalized Postman collection to ${outPath}`);
