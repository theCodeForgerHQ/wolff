import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBundleDir, checkVercelOutput } from './vercel-output';

let root = '';
afterEach(() => rm(root, { recursive: true, force: true }));

async function tree(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'vercel-output-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const HANDLER = 'apps/api/.vercel-bundle/index.mjs';
const fn = {
  'functions/index.func/.vc-config.json': JSON.stringify({ handler: HANDLER }),
  [`functions/index.func/${HANDLER}`]: 'export default 1',
};

describe('Vercel build output check', () => {
  it('passes when the bundle is only the function', async () => {
    expect(await checkVercelOutput(await tree(fn))).toEqual([]);
  });

  it.each(['static/index.mjs', 'static/apps/api/.vercel-bundle/index.mjs.map', 'static/x.js'])(
    'fails when %s is served statically',
    async (file) => {
      const problems = await checkVercelOutput(await tree({ ...fn, [file]: '' }));
      expect(problems.join('\n')).toContain(file);
    }
  );

  it('fails when a source map ships inside the function', async () => {
    const map = `functions/index.func/${HANDLER}.map`;
    expect((await checkVercelOutput(await tree({ ...fn, [map]: '{}' }))).join()).toContain(map);
  });

  it('fails when the function is not the bundle', async () => {
    const problems = await checkVercelOutput(
      await tree({
        'functions/index.func/.vc-config.json': JSON.stringify({ handler: 'apps/api/src/app.ts' }),
      })
    );
    expect(problems.join()).toMatch(/handler/);
  });

  it('accepts a bundle directory that holds only the entry', async () => {
    expect(await checkBundleDir(await tree({ 'index.mjs': '' }))).toEqual([]);
  });

  it('rejects a source map in the bundle directory', async () => {
    expect(
      (await checkBundleDir(await tree({ 'index.mjs': '', 'index.mjs.map': '' }))).join()
    ).toContain('index.mjs.map');
  });
});
