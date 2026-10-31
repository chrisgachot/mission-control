// Deploy command for Workers Builds (and for deploying by hand): `npm run deploy`.
//
//   1. Applies D1 migrations to the remote database, by binding name (DB), so it works whatever
//      the person called their database.
//   2. Deploys the Worker with real values for APP_VERSION, SPACE_NAME and SPACE_KIND.
//
// APP_VERSION is "<package.json version>+<7 char commit sha>", for example "0.2.0+a1b2c3d".
// The sha comes from WORKERS_CI_COMMIT_SHA (set by Workers Builds), then GITHUB_SHA, then git.
// .github/workflows/health-check.yml looks for that sha in GET /api/health to know the new
// version is live.
//
// SPACE_NAME and SPACE_KIND are passed through only when they are set in the build environment
// (Workers Builds > Settings > Build > Variables and secrets). That is how a shared space such as
// Light Hill is deployed without editing wrangler.jsonc, which keeps the repo fast-forwardable.
//
// `node scripts/deploy.mjs --dry-run` prints the commands and runs nothing.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const env = process.env;

function sha() {
  const fromCi = env.WORKERS_CI_COMMIT_SHA || env.GITHUB_SHA;
  if (fromCi) return fromCi.slice(0, 7);
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'dev';
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = env.APP_VERSION || `${pkg.version}+${sha()}`;

const vars = [`APP_VERSION:${version}`];
if (env.SPACE_NAME?.trim()) vars.push(`SPACE_NAME:${env.SPACE_NAME.trim()}`);
if (env.SPACE_KIND?.trim()) {
  const kind = env.SPACE_KIND.trim();
  if (kind !== 'personal' && kind !== 'shared') {
    console.error(`deploy: SPACE_KIND must be "personal" or "shared", got "${kind}".`);
    process.exit(1);
  }
  vars.push(`SPACE_KIND:${kind}`);
}

const steps = [
  ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote'],
  ['wrangler', 'deploy', '--message', `Mission Control ${version}`, ...vars.flatMap((v) => ['--var', v])],
];

for (const step of steps) {
  console.log(`\n> npx ${step.join(' ')}`);
  if (dryRun) continue;
  // APP_VERSION in the environment is picked up by scripts/build-web.mjs, which wrangler runs
  // through "build.command" in wrangler.jsonc, so the dashboard bundle reports the same version.
  const r = spawnSync('npx', step, { stdio: 'inherit', env: { ...env, APP_VERSION: version } });
  if (r.status !== 0) {
    console.error(`deploy: "${step.slice(0, 3).join(' ')}" failed (exit ${r.status}). Stopping.`);
    process.exit(r.status ?? 1);
  }
}
