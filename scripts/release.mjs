// Usage: npm run release -- <patch|minor|major|X.Y.Z>
//
// Bumps "version" in package.json (and package-lock.json if present), then prints the git
// commands to commit, tag and push. It never runs git itself. Forks pull only tags named vX.Y.Z,
// so the tag is the release.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run release -- <patch|minor|major|X.Y.Z>');
  process.exit(1);
}

const pkgUrl = new URL('../package.json', import.meta.url);
const lockUrl = new URL('../package-lock.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));

const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!m) {
  console.error(`package.json version "${pkg.version}" is not X.Y.Z`);
  process.exit(1);
}
let [major, minor, patch] = m.slice(1).map(Number);

let next;
if (arg === 'major') next = `${major + 1}.0.0`;
else if (arg === 'minor') next = `${major}.${minor + 1}.0`;
else if (arg === 'patch') next = `${major}.${minor}.${patch + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else {
  console.error(`Unknown bump "${arg}". Use patch, minor, major or X.Y.Z.`);
  process.exit(1);
}

const prev = pkg.version;
pkg.version = next;
writeFileSync(pkgUrl, JSON.stringify(pkg, null, 2) + '\n');

if (existsSync(lockUrl)) {
  const lock = JSON.parse(readFileSync(lockUrl, 'utf8'));
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  writeFileSync(lockUrl, JSON.stringify(lock, null, 2) + '\n');
}

console.log(`Version ${prev} -> ${next}\n`);
console.log('Run these yourself (this script does not touch git):\n');
console.log('  npm run typecheck && npm test');
console.log('  git add package.json package-lock.json');
console.log(`  git commit -m "Release v${next}"`);
console.log('  git push origin main');
console.log(`  git tag -a v${next} -m "v${next}"`);
console.log(`  git push origin v${next}`);
console.log('\nForks pick the tag up at their next daily sync (docs/UPDATES.md).');
