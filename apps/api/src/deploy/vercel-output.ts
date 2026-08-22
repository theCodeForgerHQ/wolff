import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Guards for the Vercel deployment of the api (apps/api/vercel.json). The
 * server bundle must become the function and nothing else: anything under
 * `.vercel/output/static` is downloadable from the deployment's URL, and a
 * source map would hand out the server's source.
 */

const CODE = /\.(c|m)?js$|\.map$/;
const BUNDLE_ENTRY = 'index.mjs';

async function files(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/** Problems with a `vercel build` output directory; empty means fine. */
export async function checkVercelOutput(outputDir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const file of await files(join(outputDir, 'static'))) {
    if (CODE.test(file)) problems.push(`served statically: ${relative(outputDir, file)}`);
  }
  const functionFiles = await files(join(outputDir, 'functions'));
  for (const file of functionFiles) {
    if (file.endsWith('.map'))
      problems.push(`source map in a function: ${relative(outputDir, file)}`);
  }
  const configs = functionFiles.filter((file) => file.endsWith('.vc-config.json'));
  if (configs.length === 0) problems.push('no function in the output');
  for (const config of configs) {
    const { handler } = JSON.parse(await readFile(config, 'utf8')) as { handler?: string };
    if (!handler?.endsWith(`.vercel-bundle/${BUNDLE_ENTRY}`)) {
      problems.push(`function handler is ${handler ?? 'missing'}, not the bundle`);
    }
  }
  return problems;
}

/** The esbuild output directory must hold the entry and nothing else. */
export async function checkBundleDir(bundleDir: string): Promise<string[]> {
  return (await files(bundleDir))
    .map((file) => relative(bundleDir, file))
    .filter((file) => file !== BUNDLE_ENTRY)
    .map((file) => `unexpected file in the bundle directory: ${file}`);
}
