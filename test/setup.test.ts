// GET /api/setup (mint once, then masked) and POST /api/setup/rotate-token (docs/ARCHITECTURE.md section 7).
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SetupResponse } from '../src/types.ts';
import { ORIGIN, apiFetch, mcpRpc, postJson, resetDb, seedSpace, sha256B64u } from './helpers.ts';
import type { Seed } from './helpers.ts';

const MASKED_URL = ORIGIN + '/mcp/' + '••••';
const URL_PATTERN = new RegExp('^' + ORIGIN.replace(/\./g, '\\.') + '/mcp/([A-Za-z0-9_-]{43})$');

let seed: Seed;

beforeEach(async () => {
  await resetDb();
  // No connector token yet, so the first GET has to mint one.
  seed = await seedSpace({ connectorToken: false });
});

function tokenFrom(url: string): string {
  const m = URL_PATTERN.exec(url);
  if (!m || !m[1]) throw new Error('not a full connector URL: ' + url);
  return m[1];
}

async function getSetup(): Promise<SetupResponse> {
  const res = await apiFetch('/api/setup', {}, seed.cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as SetupResponse;
}

describe('GET /api/setup', () => {
  it('mints a token on first read and returns the full URL once', async () => {
    const body = await getSetup();
    expect(body.tokenMasked).toBe(false);
    expect(body.connectorUrl).toMatch(URL_PATTERN);
    expect(body.instructions.claudeCode.length).toBeGreaterThan(0);
    expect(body.instructions.reportingRules).toMatch(/report/i);

    // The minted URL works as a connector.
    const { status, body: rpc } = await mcpRpc(tokenFrom(body.connectorUrl), 'tools/list');
    expect(status).toBe(200);
    expect(rpc.result.tools).toHaveLength(6);
  });

  it('returns a masked URL on the second read, with the same creation time', async () => {
    const first = await getSetup();
    const second = await getSetup();
    expect(second.tokenMasked).toBe(true);
    expect(second.connectorUrl).toBe(MASKED_URL);
    expect(second.tokenCreatedAt).toBe(first.tokenCreatedAt);
  });

  it('stores only the hash, never the plaintext token', async () => {
    const body = await getSetup();
    const token = tokenFrom(body.connectorUrl);
    const rows = await env.DB.prepare('SELECT token_hash FROM connector_tokens').all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results.map((r) => r.token_hash)).not.toContain(token);
    expect(rows.results[0]?.token_hash).toBe(await sha256B64u(token));
  });

  it('returns 401 without a session', async () => {
    const res = await SELF.fetch(new Request(ORIGIN + '/api/setup'));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/setup/rotate-token', () => {
  it('returns a new unmasked URL, and the old token then gets 401 on /mcp', async () => {
    const first = await getSetup();
    const oldToken = tokenFrom(first.connectorUrl);

    const res = await apiFetch('/api/setup/rotate-token', { method: 'POST' }, seed.cookie);
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as SetupResponse;
    expect(rotated.tokenMasked).toBe(false);
    const newToken = tokenFrom(rotated.connectorUrl);
    expect(newToken).not.toBe(oldToken);

    expect((await mcpRpc(oldToken, 'tools/list')).status).toBe(401);
    expect((await mcpRpc(newToken, 'tools/list')).status).toBe(200);

    // After rotation the page shows the masked form again.
    const after = await getSetup();
    expect(after.tokenMasked).toBe(true);
  });

  it('requires X-Requested-With (403) and leaves the current token working', async () => {
    const first = await getSetup();
    const token = tokenFrom(first.connectorUrl);
    const res = await SELF.fetch(
      new Request(ORIGIN + '/api/setup/rotate-token', { method: 'POST', headers: { Cookie: 'mc_session=' + seed.cookie } }),
    );
    expect(res.status).toBe(403);
    expect((await mcpRpc(token, 'tools/list')).status).toBe(200);
  });

  it('returns 401 without a session', async () => {
    const res = await postJson('/api/setup/rotate-token', {});
    expect(res.status).toBe(401);
  });
});
