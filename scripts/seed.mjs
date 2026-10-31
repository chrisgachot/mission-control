#!/usr/bin/env node
/**
 * Local development seed. Run `npm run migrate:local` first, then start `wrangler dev`
 * (serves http://127.0.0.1:8787), then `npm run seed:local`. Pass `--base <url>` to use another local port.
 *
 * Creates one personal space with an owner (dev-owner), a space key with a recovery wrap,
 * a connector token (devtoken), six projects, and 23 workstreams written through the real
 * MCP connector. Then backdates timestamps so the activity chart and sparklines have shape.
 *
 * This script never deletes anything. To start over, stop wrangler dev and remove
 * .wrangler/state/v3/d1 yourself, then run `npm run migrate:local` again.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = 'http://127.0.0.1:8787';
const CONNECTOR_TOKEN = 'devtoken';
const OWNER_ID = 'dev-owner';
const OWNER_HANDLE = 'Chris';
const SPACE_NAME = 'Chris (local)';
const PROJECT_NAMES = ['Field', 'Codex', 'Beacon', 'Black Falcon', 'Floorplan Repo', 'Personal'];

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** Gap between a workstream's successive updates when backdating, so each one has a spread of days. */
const STEP_MS = 18 * HOUR_MS;

/**
 * Fixture mirrored from the dashboard mockup. `hours` is time since the last agent report.
 * `log` lines become milestones; for `done` items the last line is the result; for `waiting`
 * items every line is a milestone and `needed` is the waiting update.
 */
const FIXTURE = [
  { title: 'Approve UniFi U7 Pro purchase', tool: 'duet', project: 'Black Falcon', status: 'waiting', hours: 1,
    log: ['Found best price at UI Store', 'Confirmed model with you', 'Link approval requested'],
    needed: 'Approve $214 spend in Link' },
  { title: 'Pick a session timeout for Field auth', tool: 'code', project: 'Field', status: 'waiting', hours: 3,
    log: ['Refactored token refresh', 'Tests passing', 'Paused for your decision'],
    needed: 'Choose 8h, 24h, or 7 days' },
  { title: 'Review HY35 knowledge capture draft', tool: 'cowork', project: 'Codex', status: 'waiting', hours: 20,
    log: ['Pulled interview notes', 'Drafted 14 sections', 'Draft ready for review'],
    needed: 'Read and mark up the draft' },
  { title: 'Collect vendor contacts from Light Hill Gmail', tool: 'duet', project: 'Field', status: 'running', hours: 0.5,
    log: ['Scanned 412 threads', 'Found 63 vendors', 'Matching to Field vendor list'] },
  { title: 'Uptime function for Beacon', tool: 'code', project: 'Beacon', status: 'running', hours: 2,
    log: ['Wrote Netlify Function', 'Deployed to preview', 'Monitoring 45 sites'] },
  { title: 'Status wall layout v2', tool: 'cowork', project: 'Beacon', status: 'running', hours: 30,
    log: ['Mocked two layouts', 'Added power tiles'] },
  { title: 'Schedule interview with Paula', tool: 'duet', project: 'Codex', status: 'running', hours: 5,
    log: ['Proposed three times', 'Sent invite draft'] },
  { title: 'Asset onboarding camera flow', tool: 'code', project: 'Field', status: 'running', hours: 6,
    log: ['Added barcode scan', 'Wired photo upload to Blobs'] },
  { title: 'UniFi Access door schedules', tool: 'chat', project: 'Black Falcon', status: 'running', hours: 26,
    log: ['Drafted schedule by door', 'Flagged after hours rule'] },
  { title: 'Cousy packaging quotes', tool: 'duet', project: 'Personal', status: 'running', hours: 8,
    log: ['Emailed four suppliers', 'One quote back'] },
  { title: 'OCR date extraction tuning', tool: 'code', project: 'Floorplan Repo', status: 'running', hours: 50,
    log: ['Retrained on title blocks', 'Accuracy up to 91%'] },
  { title: 'Cousy branding ideas', tool: 'chat', project: 'Personal', status: 'running', hours: 288,
    log: ['Brainstormed names', 'Sketched logo directions'] },
  { title: 'Floorplan history slider', tool: 'code', project: 'Floorplan Repo', status: 'running', hours: 216,
    log: ['Built slider UI', 'Stopped at date sorting bug'] },
  { title: 'Codex interview question bank', tool: 'chat', project: 'Codex', status: 'running', hours: 40,
    log: ['Wrote 40 questions', 'Grouped by system'] },
  { title: 'Vendor lookup search', tool: 'code', project: 'Field', status: 'done', hours: 70,
    log: ['Shipped to field.lighthillpm.com'] },
  { title: 'Codex template', tool: 'cowork', project: 'Codex', status: 'done', hours: 96,
    log: ['Template saved'] },
  { title: 'Order patch panels', tool: 'duet', project: 'Black Falcon', status: 'done', hours: 52,
    log: ['Approved in Link', 'Order confirmed'] },
  { title: 'Beacon color legend', tool: 'chat', project: 'Beacon', status: 'done', hours: 120,
    log: ['Legend finalized'] },
  { title: 'UPS power tile', tool: 'code', project: 'Beacon', status: 'done', hours: 30,
    log: ['Live on the wall'] },
  { title: 'Morning inbox triage', tool: 'duet', project: 'Personal', status: 'running', hours: 0.2,
    log: ['Sorted 38 emails', '3 need replies'] },
  { title: 'Field rollout email', tool: 'cowork', project: 'Field', status: 'done', hours: 140,
    log: ['Draft approved', 'Sent to staff'] },
  // Two ChatGPT items of our own (not from the mockup).
  { title: 'Draft Beacon status email template', tool: 'chatgpt', project: 'Beacon', status: 'running', hours: 4,
    log: ['Outlined sections', 'Wrote intro paragraph'] },
  { title: 'Choose a label name for Cousy', tool: 'chatgpt', project: 'Personal', status: 'waiting', hours: 2,
    log: ['Generated three name options', 'Checked domain availability'],
    needed: 'Pick one of the three label names' },
];

class SeedError extends Error {}

function fail(message) {
  throw new SeedError(message);
}

function parseArgs(argv) {
  let base = DEFAULT_BASE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') {
      base = argv[++i] ?? '';
    } else if (arg.startsWith('--base=')) {
      base = arg.slice('--base='.length);
    } else if (arg === '-h' || arg === '--help') {
      console.log(`Usage: npm run seed:local [-- --base http://127.0.0.1:8787]`);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  base = base.replace(/\/+$/, '');
  let url;
  try {
    url = new URL(base);
  } catch {
    fail(`--base is not a URL: ${base}`);
  }
  // This script writes the local D1 database. Refuse to aim the connector anywhere but this machine.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    fail(`--base must point at a local wrangler dev (got ${url.hostname}). This seed only writes the local database.`);
  }
  return { base };
}

/** Bundles src/crypto/index.ts so the seed uses exactly the code the Worker and browser use. */
async function loadCrypto() {
  const outfile = path.join(os.tmpdir(), 'mission-control-seed-crypto.mjs');
  try {
    await build({
      entryPoints: [path.join(ROOT, 'src/crypto/index.ts')],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      outfile,
      logLevel: 'silent',
    });
  } catch (err) {
    fail(`could not bundle src/crypto/index.ts with esbuild: ${err.message}`);
  }
  const mod = await import(pathToFileURL(outfile).href);
  const required = ['generateSpaceKeyPair', 'wrapWithSecret', 'generateRecoveryCode', 'recoveryCodeToSecret'];
  const missing = required.filter((name) => typeof mod[name] !== 'function');
  if (missing.length > 0) {
    fail(`src/crypto/index.ts does not export: ${missing.join(', ')}`);
  }
  return mod;
}

async function checkDevServer(base) {
  let res;
  try {
    res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    fail(
      `nothing is answering at ${base}. Start the Worker with \`npm run dev\` (wrangler dev), then rerun. ` +
        'Pass --base <url> if it runs on another port.',
    );
  }
  let body;
  try {
    body = await res.json();
  } catch {
    fail(`${base}/api/health did not return JSON. Is this Mission Control?`);
  }
  if (body?.db === 'error') {
    fail('the local database answered with an error. Run `npm run migrate:local`, then rerun the seed.');
  }
}

/** Runs `wrangler d1 execute DB --local` with an argument array (no shell, so no quoting surprises). */
function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`wrangler exited ${code}: ${(stderr || stdout).trim().slice(-800)}`));
    });
  });
}

/** Runs one SQL statement against the local D1 and returns its result rows. */
async function sql(statement) {
  let out;
  try {
    out = await runWrangler(['d1', 'execute', 'DB', '--local', '--command', statement, '--json']);
  } catch (err) {
    if (/no such table/i.test(err.message)) {
      fail('the local database has no tables yet. Run `npm run migrate:local`, then rerun the seed.');
    }
    throw err;
  }
  const start = out.search(/\[\s*[{\]]/);
  if (start < 0) throw new Error('could not read the JSON output of wrangler d1 execute');
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

/** SQL literal. Strings get single quotes doubled. */
function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in SQL');
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insert(table, row) {
  const cols = Object.keys(row).join(', ');
  const vals = Object.values(row).map(lit).join(', ');
  return `INSERT INTO ${table} (${cols}) VALUES (${vals})`;
}

async function checkNotSeeded() {
  const setup = await sql("SELECT value FROM space_meta WHERE key = 'setup_complete'");
  const users = await sql('SELECT COUNT(*) AS n FROM users');
  if (setup.length > 0 || Number(users[0]?.n ?? 0) > 0) {
    fail(
      'this local database is already seeded or partly set up (space_meta.setup_complete or users exist).\n' +
        'To start over: stop wrangler dev, delete .wrangler/state/v3/d1 in this repo yourself, run `npm run migrate:local`, then `npm run seed:local`.',
    );
  }
}

/** Minimal Streamable HTTP client for the connector: stateless JSON-RPC over POST. */
class ConnectorClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.protocolVersion = null;
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion;
    return h;
  }

  async request(method, params) {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
    const msg = parseRpc(res.headers.get('content-type') ?? '', text, id);
    if (!msg) throw new Error(`${method}: empty response`);
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result;
  }

  async notify(method) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
    if (!res.ok && res.status !== 202) throw new Error(`${method}: HTTP ${res.status}`);
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'seed', version: '0' },
    });
    this.protocolVersion = result?.protocolVersion ?? '2025-06-18';
    await this.notify('notifications/initialized');
  }

  /** Calls a tool and returns its JSON payload (the connector returns JSON as text content). */
  async tool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = result?.content?.[0]?.text ?? '';
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
    if (result?.isError) {
      throw new Error(`${name} failed: ${payload?.error?.message ?? text}`);
    }
    return payload;
  }
}

/** Accepts a JSON body, or an SSE body, and returns the message with the given id. */
function parseRpc(contentType, text, id) {
  if (!text) return null;
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      const msg = JSON.parse(data);
      if (msg.id === id) return msg;
    }
    return null;
  }
  return JSON.parse(text);
}

async function sha256B64u(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(digest).toString('base64url');
}

async function main() {
  const { base } = parseArgs(process.argv.slice(2));
  const cryptoMod = await loadCrypto();

  // Keys first, so a stub or broken crypto module fails before anything else is touched.
  // The space key encrypts all workstream text; the user key is a dev artifact (see output).
  const now = Date.now();
  const setupAt = now - 21 * DAY_MS;
  const kid = crypto.randomUUID();
  let space;
  let user;
  let recoveryCode;
  let wrappedSpace;
  try {
    space = await cryptoMod.generateSpaceKeyPair();
    user = await cryptoMod.generateSpaceKeyPair();
    recoveryCode = cryptoMod.generateRecoveryCode();
    const secret = cryptoMod.recoveryCodeToSecret(recoveryCode);
    wrappedSpace = await cryptoMod.wrapWithSecret('recovery', kid, space.privateKeyPkcs8, secret);
  } catch (err) {
    fail(
      `key generation failed: ${err.message}. src/crypto may still be a stub. ` +
        'The seed needs the real module from the Security track; rerun when it lands.',
    );
  }

  await checkDevServer(base);
  await checkNotSeeded();

  console.log('Writing rows to the local database...');
  await sql(insert('space_meta', { key: 'name', value: SPACE_NAME }));
  await sql(insert('space_meta', { key: 'kind', value: 'personal' }));
  await sql(insert('space_meta', { key: 'created_at', value: String(setupAt) }));
  await sql(insert('space_keys', { id: kid, public_key: space.publicKeyRaw, created_at: setupAt }));
  await sql(
    insert('users', {
      id: OWNER_ID,
      handle: OWNER_HANDLE,
      role: 'owner',
      public_key: user.publicKeyRaw,
      created_at: setupAt,
    }),
  );
  // Only the space key is wrapped here: wrapped_keys.key_id references space_keys.
  await sql(
    insert('wrapped_keys', {
      id: crypto.randomUUID(),
      user_id: OWNER_ID,
      key_id: kid,
      wrap_kind: 'recovery',
      credential_id: null,
      wrapped: JSON.stringify(wrappedSpace),
      created_at: setupAt,
    }),
  );
  await sql(
    insert('connector_tokens', {
      id: crypto.randomUUID(),
      user_id: OWNER_ID,
      token_hash: await sha256B64u(CONNECTOR_TOKEN),
      label: 'seed',
      created_at: setupAt,
    }),
  );
  for (const [i, name] of PROJECT_NAMES.entries()) {
    await sql(
      insert('projects', {
        id: crypto.randomUUID(),
        name,
        remote_space_id: null,
        remote_project_id: null,
        sort_order: i,
        created_at: setupAt,
      }),
    );
  }
  // Last, so a half-finished run is detectable by the check above.
  await sql(insert('space_meta', { key: 'setup_complete', value: '1' }));

  // Workstreams go through the real connector, so the Worker's own encryption and status logic run.
  const connectorUrl = `${base}/mcp/${CONNECTOR_TOKEN}`;
  const mcp = new ConnectorClient(connectorUrl);
  await mcp.initialize();
  const listed = await mcp.tool('list_projects', {});
  const projectIds = new Map((listed.projects ?? []).map((p) => [p.name, p.id]));
  for (const name of PROJECT_NAMES) {
    if (!projectIds.has(name)) fail(`list_projects does not return project "${name}"`);
  }

  console.log(`Reporting ${FIXTURE.length} workstreams through the connector...`);
  const plan = [];
  for (const [i, item] of FIXTURE.entries()) {
    const started = await mcp.tool('report_started', {
      title: item.title,
      project_id: projectIds.get(item.project),
      tool: item.tool,
      external_id: `seed-${i + 1}`,
    });
    const workstreamId = started.workstream_id;
    if (!workstreamId) fail(`report_started returned no workstream_id for "${item.title}"`);

    // Updates written for this workstream, in order. Used for backdating.
    let updateCount = 1;
    const milestones = item.status === 'done' ? item.log.slice(0, -1) : item.log;
    for (const note of milestones) {
      await mcp.tool('report_milestone', { workstream_id: workstreamId, note });
      updateCount++;
    }
    if (item.status === 'waiting') {
      await mcp.tool('report_waiting', { workstream_id: workstreamId, needed: item.needed });
      updateCount++;
    } else if (item.status === 'done') {
      await mcp.tool('report_done', { workstream_id: workstreamId, result: item.log[item.log.length - 1] });
      updateCount++;
    }
    plan.push({ workstreamId, hours: item.hours, status: item.status, updateCount });
  }

  // Backdate. Newest update sits at now - hours. Each earlier update is STEP_MS further back.
  console.log('Backdating timestamps so the charts have shape...');
  for (const p of plan) {
    const ageMs = Math.round(p.hours * HOUR_MS);
    const lastMs = now - ageMs;
    const createdMs = lastMs - (p.updateCount - 1) * STEP_MS;
    const wsLit = lit(p.workstreamId);
    await sql(
      `UPDATE updates SET created_at = CAST(${now} - ${ageMs} - ` +
        `(SELECT COUNT(*) FROM updates AS later WHERE later.workstream_id = updates.workstream_id AND later.rowid > updates.rowid) ` +
        `* ${STEP_MS} AS INTEGER) WHERE workstream_id = ${wsLit}`,
    );
    const doneAt = p.status === 'done' ? String(lastMs) : 'NULL';
    await sql(
      `UPDATE workstreams SET created_at = ${createdMs}, updated_at = ${lastMs}, last_agent_at = ${lastMs}, ` +
        `done_at = ${doneAt} WHERE id = ${wsLit}`,
    );
  }

  const updateTotal = plan.reduce((sum, p) => sum + p.updateCount, 0);
  console.log('');
  console.log('Seeded local Mission Control.');
  console.log(`  Projects:        ${PROJECT_NAMES.length}`);
  console.log(`  Workstreams:     ${plan.length} (${updateTotal} updates)`);
  console.log(`  Connector URL:   ${connectorUrl}`);
  console.log(`  Recovery code:   ${recoveryCode}`);
  console.log('                   Shown once here. It is stored only as a wrapped key.');
  console.log(`  Owner id:        ${OWNER_ID}`);
  console.log('');
  console.log('  Owner private key (PKCS8, base64url). DEV ONLY, for the local seed database.');
  console.log('  It is not stored and the unlock flow does not need it. Do not paste it anywhere else.');
  console.log(`  ${user.privateKeyPkcs8}`);
  console.log('');
  console.log('To unlock locally:');
  console.log(`  1. Add DEV_BYPASS_USER_ID=${OWNER_ID} to .dev.vars (this repo's .dev.vars is gitignored).`);
  console.log('  2. Restart wrangler dev.');
  console.log(`  3. Open ${base} and enter the recovery code above.`);
}

main().catch((err) => {
  if (err instanceof SeedError) {
    console.error(`seed: ${err.message}`);
  } else {
    console.error(`seed: unexpected error: ${err.message}`);
  }
  process.exitCode = 1;
});
