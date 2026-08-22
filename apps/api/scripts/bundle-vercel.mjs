// Bundles the Vercel function entry (src/index.ts) into one ES module.
//
// The workspace packages (@wolff/*) export TypeScript sources and are not
// published, so they are compiled into the bundle. Every other package stays
// an import: Vercel traces those from node_modules and ships them with the
// function, which keeps native and data-file dependencies (Prisma's adapter,
// Sentry, OpenTelemetry) working as installed.
import { build } from 'esbuild';

const workspacePackages = /^@wolff\//;

await build({
  entryPoints: ['src/index.ts'],
  outfile: '.vercel-bundle/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'external-npm-packages',
      setup(b) {
        // Bare specifiers that are not workspace packages stay external.
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          workspacePackages.test(args.path) ? undefined : { path: args.path, external: true }
        );
      },
    },
  ],
});
