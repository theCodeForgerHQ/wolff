// Usage: tsx scripts/check-vercel-output.ts [bundle|output] <dir>
//   bundle <dir>: run in the build; the esbuild directory holds only index.mjs.
//   output <dir>: run after `vercel build`; no code in static/, no source
//                 maps, and the function handler is the bundle.
import { checkBundleDir, checkVercelOutput } from '../src/deploy/vercel-output';

const [mode, dir] = process.argv.slice(2);
if ((mode !== 'bundle' && mode !== 'output') || !dir) {
  console.error('usage: check-vercel-output.ts bundle|output <dir>');
  process.exit(2);
}
void (mode === 'bundle' ? checkBundleDir(dir) : checkVercelOutput(dir)).then((problems) => {
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(`vercel ${mode} check passed: ${dir}`);
});
