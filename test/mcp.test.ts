// /mcp/:token: token auth, transport rules, and the six agent tools (docs/ARCHITECTURE.md section 4).
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ORIGIN, callTool, mcpCall, mcpRpc, openField, resetDb, seedSpace } from './helpers.ts';
import type { Seed } from './helpers.ts';

const TOOL_NAMES = ['find_workstreams', 'list_projects', 'report_done', 'report_milestone', 'report_started', 'report_waiting'];

interface WsRow {
  id: string;
  title_enc: string;
  status: string;
  project_id: string;
  origin_user_id: string | null;
  key_id: string;
  external_id: string | null;
  done_at: number | null;
  link_enc: string | null;
}

async function wsRow(id: string): Promise<WsRow | null> {
  return env.DB.prepare('SELECT id, title_enc, status, project_id, origin_user_id, key_id, external_id, done_at, link_enc FROM workstreams WHERE id = ?1')
    .bind(id)
    .first<WsRow>();
}

async function updateKinds(id: string): Promise<string[]> {
  const res = await env.DB.prepare('SELECT kind FROM updates WHERE workstream_id = ?1 ORDER BY created_at, rowid').bind(id).all<{ kind: string }>();
  return res.results.map((r) => r.kind);
}

let seed: Seed;
let token: string;

beforeEach(async () => {
  await resetDb();
  seed = await seedSpace();
  token = seed.connectorToken as string;
});

describe('token auth and transport', () => {
  it('returns 401 JSON for an unknown token', async () => {
    const res = await SELF.fetch(
      new Request(ORIGIN + '/mcp/not-a-real-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 once the token is revoked', async () => {
    await env.DB.prepare('UPDATE connector_tokens SET revoked_at = ?1 WHERE user_id = ?2').bind(Date.now(), seed.userId).run();
    const { status } = await mcpRpc(token, 'tools/list');
    expect(status).toBe(401);
  });

  it('answers GET with 405 and Allow: POST', async () => {
    const res = await SELF.fetch(new Request(ORIGIN + '/mcp/' + token, { method: 'GET', headers: { Accept: 'text/event-stream' } }));
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('method_not_allowed');
  });

  it('records last_used_at on a successful call', async () => {
    await mcpRpc(token, 'tools/list');
    // touchConnectorToken runs via waitUntil, so it may land a moment after the response. Poll briefly.
    let lastUsed: number | null = null;
    for (let i = 0; i < 40 && lastUsed === null; i++) {
      const row = await env.DB.prepare('SELECT last_used_at FROM connector_tokens WHERE user_id = ?1')
        .bind(seed.userId)
        .first<{ last_used_at: number | null }>();
      lastUsed = row?.last_used_at ?? null;
      if (lastUsed === null) await new Promise((r) => setTimeout(r, 25));
    }
    expect(lastUsed).not.toBeNull();
  });
});

describe('protocol', () => {
  it('initialize returns the reporting instructions', async () => {
    const result = await mcpCall(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-agent', version: '0.0.0' },
    });
    expect(result.serverInfo.name).toBe('mission-control');
    expect(result.instructions).toMatch(/report/i);
    expect(result.instructions).toContain('list_projects');
  });

  it('tools/list advertises exactly the six agent tools', async () => {
    const result = await mcpCall(token, 'tools/list');
    const names = (result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(TOOL_NAMES);
  });

  it('list_projects returns the seeded projects and the reporting rules', async () => {
    const out = await callTool(token, 'list_projects', {});
    expect(out.isError).toBe(false);
    expect(out.data.projects.map((p: { name: string }) => p.name)).toEqual(['Website', 'Ops']);
    expect(out.data.projects[0]).toMatchObject({ id: seed.projects[0]?.id, space: env.SPACE_NAME });
    expect(out.data.rules).toMatch(/report/i);
  });
});

describe('report_started', () => {
  it('returns a workstream_id and stores the title encrypted to the space key', async () => {
    const title = 'Draft Q4 board update';
    const out = await callTool(token, 'report_started', {
      title,
      project_id: seed.projects[0]?.id,
      tool: 'code',
      link: 'https://claude.ai/code/session_abc',
    });
    expect(out.isError).toBe(false);
    expect(out.data).toMatchObject({ title, project: 'Website', status: 'running' });
    const id: string = out.data.workstream_id;
    expect(id).toEqual(expect.any(String));

    const row = await wsRow(id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('running');
    expect(row?.key_id).toBe(seed.kid);
    expect(row?.origin_user_id).toBe(seed.userId);
    expect(row?.title_enc).not.toContain(title);
    expect(await openField(row?.title_enc ?? '', seed.privateKey)).toBe(title);
    expect(row?.link_enc).not.toBeNull();
    expect(await openField(row?.link_enc ?? '', seed.privateKey)).toBe('https://claude.ai/code/session_abc');
    expect(await updateKinds(id)).toEqual(['started']);
  });

  it('returns the same workstream for a repeated external_id, without a second row', async () => {
    const args = { title: 'Fix login redirect', project_id: seed.projects[0]?.id, tool: 'code', external_id: 'session-42' };
    const first = await callTool(token, 'report_started', args);
    const second = await callTool(token, 'report_started', args);
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(second.data.workstream_id).toBe(first.data.workstream_id);
    expect(second.data.reused).toBe(true);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM workstreams WHERE external_id = ?1').bind('session-42').first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect(await updateKinds(first.data.workstream_id)).toEqual(['started']);
  });

  it('returns a tool error for a project_id that is not in the list', async () => {
    const out = await callTool(token, 'report_started', {
      title: 'Anything',
      project_id: 'no-such-project',
      tool: 'code',
    });
    expect(out.isError).toBe(true);
    expect(out.data.error.code).toBe('unknown_project');
  });

  it('returns a tool error for a whitespace-only title', async () => {
    const out = await callTool(token, 'report_started', { title: '   ', project_id: seed.projects[0]?.id, tool: 'code' });
    expect(out.isError).toBe(true);
    expect(out.data.error.code).toBe('bad_input');
  });
});

describe('report_milestone, report_waiting, report_done', () => {
  async function start(): Promise<string> {
    const out = await callTool(token, 'report_started', { title: 'Migrate billing tables', project_id: seed.projects[0]?.id, tool: 'code' });
    return out.data.workstream_id as string;
  }

  it('milestone keeps it running, then waiting sets status waiting', async () => {
    const id = await start();
    const m = await callTool(token, 'report_milestone', { workstream_id: id, note: 'tests passing' });
    expect(m.isError).toBe(false);
    expect(m.data).toEqual({ ok: true, status: 'running' });
    expect((await wsRow(id))?.status).toBe('running');

    const w = await callTool(token, 'report_waiting', { workstream_id: id, needed: 'approve $214' });
    expect(w.isError).toBe(false);
    expect(w.data).toEqual({ ok: true, status: 'waiting' });
    expect((await wsRow(id))?.status).toBe('waiting');
    expect(await updateKinds(id)).toEqual(['started', 'milestone', 'waiting']);

    // The needed text is encrypted, and the agent's note is the one the person sees on the board.
    const waitingUpdate = await env.DB.prepare("SELECT body_enc FROM updates WHERE workstream_id = ?1 AND kind = 'waiting'")
      .bind(id)
      .first<{ body_enc: string }>();
    expect(await openField(waitingUpdate?.body_enc ?? '', seed.privateKey)).toBe('approve $214');
  });

  it('report_done sets status done and done_at', async () => {
    const id = await start();
    const before = Date.now();
    const out = await callTool(token, 'report_done', { workstream_id: id, result: 'PR #214 merged' });
    expect(out.isError).toBe(false);
    expect(out.data).toEqual({ ok: true, status: 'done' });
    const row = await wsRow(id);
    expect(row?.status).toBe('done');
    expect(row?.done_at).toBeGreaterThanOrEqual(before);
  });

  it('an unknown workstream_id is a tool error with isError true, not an HTTP 500', async () => {
    const { status, body } = await mcpRpc(token, 'tools/call', {
      name: 'report_milestone',
      arguments: { workstream_id: 'does-not-exist', note: 'tests passing' },
    });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    const out = await callTool(token, 'report_milestone', { workstream_id: 'does-not-exist', note: 'tests passing' });
    expect(out.isError).toBe(true);
    expect(out.data.error.code).toBe('not_found');
  });

  it('refuses to report on an archived workstream', async () => {
    const id = await start();
    await env.DB.prepare("UPDATE workstreams SET status = 'archived', archived_at = ?1 WHERE id = ?2").bind(Date.now(), id).run();
    const out = await callTool(token, 'report_waiting', { workstream_id: id, needed: 'pick a timeout' });
    expect(out.isError).toBe(true);
    expect(out.data.error.code).toBe('archived');
  });
});

describe('find_workstreams', () => {
  it('finds a workstream by external_id with its stored status', async () => {
    const started = await callTool(token, 'report_started', {
      title: 'Pick a timeout',
      project_id: seed.projects[1]?.id,
      tool: 'chat',
      external_id: 'thread-7',
    });
    await callTool(token, 'report_waiting', { workstream_id: started.data.workstream_id, needed: 'pick a timeout' });
    const out = await callTool(token, 'find_workstreams', { external_id: 'thread-7' });
    expect(out.isError).toBe(false);
    expect(out.data.workstreams).toHaveLength(1);
    expect(out.data.workstreams[0]).toMatchObject({ id: started.data.workstream_id, project: 'Ops', status: 'waiting', tool: 'chat' });
  });

  it('query matches external_id and project name; LIKE wildcards in query are literal', async () => {
    await callTool(token, 'report_started', { title: 'Alpha', project_id: seed.projects[0]?.id, tool: 'code', external_id: 'thread-alpha' });
    await callTool(token, 'report_started', { title: 'Beta', project_id: seed.projects[1]?.id, tool: 'code', external_id: 'thread-beta' });

    const byExternal = await callTool(token, 'find_workstreams', { query: 'ALPHA' });
    expect(byExternal.data.workstreams.map((w: { external_id: string }) => w.external_id)).toEqual(['thread-alpha']);

    const byProject = await callTool(token, 'find_workstreams', { query: 'ops' });
    expect(byProject.data.workstreams.map((w: { project: string }) => w.project)).toEqual(['Ops']);

    // '%' and '_' must not act as wildcards, so these match nothing.
    expect((await callTool(token, 'find_workstreams', { query: '%' })).data.workstreams).toEqual([]);
    expect((await callTool(token, 'find_workstreams', { query: 'thread_alpha' })).data.workstreams).toEqual([]);
  });

  it('status and project_id filters narrow the results', async () => {
    const a = await callTool(token, 'report_started', { title: 'One', project_id: seed.projects[0]?.id, tool: 'code' });
    await callTool(token, 'report_done', { workstream_id: a.data.workstream_id, result: 'done' });
    await callTool(token, 'report_started', { title: 'Two', project_id: seed.projects[1]?.id, tool: 'code' });

    const done = await callTool(token, 'find_workstreams', { status: 'done' });
    expect(done.data.workstreams.map((w: { id: string }) => w.id)).toEqual([a.data.workstream_id]);

    const inOps = await callTool(token, 'find_workstreams', { project_id: seed.projects[1]?.id });
    expect(inOps.data.workstreams.map((w: { project: string }) => w.project)).toEqual(['Ops']);
  });
});
