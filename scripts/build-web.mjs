// Bundles the dashboard (web/src/app.ts) into public/app.js with esbuild.
// Shared crypto in src/crypto is imported directly by the browser code, so it is bundled too.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';

mkdirSync('public', { recursive: true });

let version = process.env.APP_VERSION;
if (!version) {
  try {
    version = execSync('git describe --tags --always --dirty', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    version = 'dev';
  }
}

const entry = existsSync('web/src/app.ts') ? 'web/src/app.ts' : null;
if (!entry) {
  console.log('build-web: web/src/app.ts not present yet, skipping bundle');
  process.exit(0);
}

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: 'public/app.js',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  define: { __APP_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
});
