// Shared fixtures for the integration tests. Every request goes through SELF.fetch, so the real Worker
// (routers, middleware, D1) runs. Browser sessions are inserted directly into D1 (see seedSpace): the dev
// bypass only applies to localhost, and the tests use mission-control.test, so cookies are the real path.
import { env, SELF } from 'cloudflare:test';
import { decryptEnvelope, encryptForKey, generateSpaceKeyPair, parseEnvelope, randomToken } from '../src/crypto/index.ts';
import type { Role } from '../src/types.ts';

export const ORIGIN = 'https://mission-control.test';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'mission-control';

/**
 * sha256 as base64url without padding: the storage rule for sessions.id, connector_tokens.token_hash and
 * member_tokens.token_hash (docs/ARCHITECTURE.md sections 3 and 4). Written out here instead of imported
 * from src, so a wrong hashing scheme in src shows up as a failing test rather than cancelling out.
 */
export async function sha256B64u(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Child tables before parents, so foreign keys hold while rows are removed. Test DB only. */
const TABLES = [
  'updates',
  'workstreams',
  'projects',
  'remote_spaces',
  'member_tokens',
  'connector_tokens',
  'sessions',
  'wrapped_keys',
  'invites',
  'challenges',
  'credentials',
  'space_keys',
  'users',
  'space_meta',
];

/** Empties every table so each test starts from a blank space. Migrations stay applied. */
export async function resetDb(): Promise<void> {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare('DELETE FROM ' + t)));
}

export interface SeededProject {
  id: string;
  name: string;
}

export interface Seed {
  /** The owner's user id. */
  userId: string;
  /** Raw mc_session cookie value. Send as `Cookie: mc_session=<value>`. */
  cookie: string;
  /** Current space key id (kid). */
  kid: string;
  /** Space public key, raw P-256, base64url. */
  publicKey: string;
  /** Space private key, PKCS8. Lets tests decrypt envelopes exactly as the dashboard would. */
  privateKey: string;
  /** Plaintext connector token, or null when seeded without one. */
  connectorToken: string | null;
  /** Two local projects: 'Website' (sort 1) and 'Ops' (sort 2). */
  projects: SeededProject[];
}

/**
 * Inserts a complete, set-up personal space: setup_complete, an owner with a live session, one space key
 * (real P-256 pair), a connector token (hash only in D1), and two projects. Safe to call repeatedly.
 */
export async function seedSpace(opts: { connectorToken?: boolean } = {}): Promise<Seed> {
  const now = Date.now();
  const space = await generateSpaceKeyPair();
  const owner = await generateSpaceKeyPair();
  const kid = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const cookie = randomToken();
  const connectorToken = opts.connectorToken === false ? null : randomToken();
  const projects: SeededProject[] = [
    { id: crypto.randomUUID(), name: 'Website' },
    { id: crypto.randomUUID(), name: 'Ops' },
  ];

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("INSERT INTO space_meta (key, value) VALUES ('setup_complete', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"),
    env.DB.prepare('INSERT INTO users (id, handle, role, public_key, created_at, removed_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)').bind(
      userId,
      'chris',
      'owner',
      owner.publicKeyRaw,
      now,
    ),
    env.DB.prepare('INSERT INTO space_keys (id, public_key, created_at, retired_at) VALUES (?1, ?2, ?3, NULL)').bind(
      kid,
      space.publicKeyRaw,
      now,
    ),
    env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(
      await sha256B64u(cookie),
      userId,
      now,
      now + DAY_MS,
    ),
  ];
  if (connectorToken !== null) {
    stmts.push(
      env.DB.prepare('INSERT INTO connector_tokens (id, user_id, token_hash, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(
        crypto.randomUUID(),
        userId,
        await sha256B64u(connectorToken),
        'test',
        now,
      ),
    );
  }
  projects.forEach((p, i) =>
    stmts.push(
      env.DB.prepare('INSERT INTO projects (id, name, sort_order, created_at) VALUES (?1, ?2, ?3, ?4)').bind(p.id, p.name, i + 1, now),
    ),
  );
  await env.DB.batch(stmts);

  return { userId, cookie, kid, publicKey: space.publicKeyRaw, privateKey: space.privateKeyPkcs8, connectorToken, projects };
}

/** Adds another user with a live session (for role checks). */
export async function addUser(role: Role, handle: string): Promise<{ userId: string; cookie: string }> {
  const now = Date.now();
  const userId = crypto.randomUUID();
  const cookie = randomToken();
  const pair = await generateSpaceKeyPair();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, handle, role, public_key, created_at, removed_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)').bind(
      userId,
      handle,
      role,
      pair.publicKeyRaw,
      now,
    ),
    env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(
      await sha256B64u(cookie),
      userId,
      now,
      now + DAY_MS,
    ),
  ]);
  return { userId, cookie };
}

/** Mints a member token for a user (shared-space forwarding). Returns the plaintext token. */
export async function addMemberToken(userId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO member_tokens (id, user_id, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(crypto.randomUUID(), userId, await sha256B64u(token), Date.now())
    .run();
  return token;
}

/** Encrypts plaintext to the seeded space key, as the dashboard or a forwarding Worker would. Returns envelope JSON text. */
export async function sealFor(seed: Pick<Seed, 'kid' | 'publicKey'>, text: string): Promise<string> {
  return JSON.stringify(await encryptForKey(seed.kid, seed.publicKey, text));
}

/** Decrypts an envelope stored in a *_enc column with the space private key. */
export async function openField(enc: string, privateKey: string): Promise<string> {
  return decryptEnvelope(parseEnvelope(enc), privateKey);
}

/**
 * Browser API request. Adds the mc_session cookie (when given) and X-Requested-With, which every
 * state-changing route requires. Use SELF.fetch directly to test the header's absence.
 */
export function apiFetch(path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, CSRF_VALUE);
  if (cookie) headers.set('Cookie', 'mc_session=' + cookie);
  return SELF.fetch(new Request(ORIGIN + path, { ...init, headers }));
}

/** POST JSON through apiFetch. */
export function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
  return apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, cookie);
}

// ---------------------------------------------------------------- MCP

export interface RpcEnvelope {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

export interface ToolResult {
  isError: boolean;
  /** content[0].text parsed as JSON. For tool errors this is { error: { code, message } }. */
  data: any;
}

let rpcId = 0;

/** Raw JSON-RPC POST to /mcp/<token>. Returns the HTTP status and the parsed body. */
export async function mcpRpc(token: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: RpcEnvelope }> {
  const res = await SELF.fetch(
    new Request(ORIGIN + '/mcp/' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RpcEnvelope };
}

/**
 * JSON-RPC call returning the `result`. For tools/call the result is unwrapped to { isError, data },
 * where data is content[0].text parsed as JSON. Throws on a JSON-RPC protocol error.
 */
export async function mcpCall(token: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const { status, body } = await mcpRpc(token, method, params);
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code} (HTTP ${status}): ${body.error.message}`);
  if (method !== 'tools/call') return body.result;
  const result = body.result as { isError?: boolean; content: { type: string; text: string }[] };
  const first = result.content[0];
  return { isError: result.isError === true, data: first ? JSON.parse(first.text) : null } satisfies ToolResult;
}

/** Shorthand for tools/call. */
export function callTool(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return mcpCall(token, 'tools/call', { name, arguments: args });
}
