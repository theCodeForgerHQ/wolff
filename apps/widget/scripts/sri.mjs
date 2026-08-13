// Writes dist/sri.json: the Subresource Integrity hash of each published
// bundle ("SRI hash published per release"). A host page embeds
// the script with integrity="<hash>" crossorigin="anonymous", so a CDN that
// serves different bytes is refused by the browser.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function sriHash(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dist = join(import.meta.dirname, '..', 'dist');
  const files = ['widget.iife.js', 'widget.es.js'];
  const manifest = Object.fromEntries(
    files.map((file) => [file, sriHash(readFileSync(join(dist, file)))])
  );
  writeFileSync(join(dist, 'sri.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(manifest);
}
