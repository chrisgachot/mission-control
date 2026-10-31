// POST /api/workstreams/:id/action and GET /api/workstreams/:id (docs/ARCHITECTURE.md section 2).
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkstreamDetail } from '../src/types.ts';
import { CSRF_HEADER, DAY_MS, ORIGIN, apiFetch, callTool, openField, postJson, resetDb, seedSpace } from './helpers.ts';
import type { Seed } from './helpers.ts';

let seed: Seed;
let token: string;

beforeEach(async () => {
  await resetDb();
  seed = await seedSpace();
  token = seed.connectorToken as string;
});

async function newWorkstream(title = 'Draft Q4 board update'): Promise<string> {
  const out = await callTool(token, 'report_started', { title, project_id: seed.projects[0]?.id, tool: 'code' });
  return out.data.workstream_id as string;
}

async function act(id: string, action: string): Promise<{ status: number; body: any }> {
  const res = await postJson(`/api/workstreams/${id}/action`, { action }, seed.cookie);
  return { status: res.status, body: await res.json() };
}

async function detail(id: string): Promise<WorkstreamDetail> {
  const res = await apiFetch('/api/workstreams/' + id, {}, seed.cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkstreamDetail;
}

async function setStatus(id: string, status: string): Promise<void> {
  await env.DB.prepare('UPDATE workstreams SET status = ?1 WHERE id = ?2').bind(status, id).run();
}

describe('person actions', () => {
  it('handled: waiting becomes running and appends a person action update', async () => {
    const id = await newWorkstream();
    await callTool(token, 'report_waiting', { workstream_id: id, needed: 'approve $214' });
    const before = Date.now();
    const { status, body } = await act(id, 'handled');
    expect(status).toBe(200);
    const ws = (body as WorkstreamDetail).workstream;
    expect(ws.status).toBe('running');
    expect(ws.derived).toBe('running');
    expect(ws.updatedAt).toBeGreaterThanOrEqual(before);

    const last = (body as WorkstreamDetail).updates.at(-1);
    expect(last).toMatchObject({ kind: 'action', actor: 'person' });
    expect(await openField(last?.bodyEnc ?? '', seed.privateKey)).toBe('Handled');
  });

  it('snooze: sets snoozed_until to now + 24h and appends an action update', async () => {
    const id = await newWorkstream();
    const before = Date.now();
    const { status, body } = await act(id, 'snooze');
    const after = Date.now();
    expect(status).toBe(200);
    const ws = (body as WorkstreamDetail).workstream;
    expect(ws.snoozedUntil).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(ws.snoozedUntil).toBeLessThanOrEqual(after + DAY_MS);
    expect(ws.status).toBe('running');
    expect((body as WorkstreamDetail).updates.at(-1)).toMatchObject({ kind: 'action', actor: 'person' });
  });

  it('archive: status becomes archived with archived_at set', async () => {
    const id = await newWorkstream();
    const before = Date.now();
    const { status, body } = await act(id, 'archive');
    expect(status).toBe(200);
    const ws = (body as WorkstreamDetail).workstream;
    expect(ws.status).toBe('archived');
    expect(ws.derived).toBe('archived');
    expect(ws.archivedAt).toBeGreaterThanOrEqual(before);
  });

  it('archive is also allowed from done', async () => {
    const id = await newWorkstream();
    await callTool(token, 'report_done', { workstream_id: id, result: 'PR #214 merged' });
    const { status, body } = await act(id, 'archive');
    expect(status).toBe(200);
    expect((body as WorkstreamDetail).workstream.status).toBe('archived');
  });

  it('resume: running again, last_agent_at refreshed (leaves going cold), clears snooze', async () => {
    const id = await newWorkstream();
    await callTool(token, 'report_waiting', { workstream_id: id, needed: 'pick a timeout' });
    // Make it cold and snoozed, then resume.
    await env.DB.prepare('UPDATE workstreams SET last_agent_at = ?1, snoozed_until = ?2 WHERE id = ?3')
      .bind(Date.now() - 8 * DAY_MS, Date.now() + DAY_MS, id)
      .run();
    const before = Date.now();
    const { status, body } = await act(id, 'resume');
    expect(status).toBe(200);
    const ws = (body as WorkstreamDetail).workstream;
    expect(ws.status).toBe('running');
    expect(ws.lastAgentAt).toBeGreaterThanOrEqual(before);
    expect(ws.snoozedUntil).toBeNull();
    expect(ws.derived).toBe('running');
    expect((body as WorkstreamDetail).updates.at(-1)).toMatchObject({ kind: 'action', actor: 'person' });
  });

  it('reopen from done: running, done_at cleared, last_agent_at refreshed', async () => {
    const id = await newWorkstream();
    await callTool(token, 'report_done', { workstream_id: id, result: 'PR #214 merged' });
    const before = Date.now();
    const { status, body } = await act(id, 'reopen');
    expect(status).toBe(200);
    const ws = (body as WorkstreamDetail).workstream;
    expect(ws.status).toBe('running');
    expect(ws.doneAt).toBeNull();
    expect(ws.archivedAt).toBeNull();
    expect(ws.lastAgentAt).toBeGreaterThanOrEqual(before);
  });

  it('reopen from archived: running, archived_at cleared', async () => {
    const id = await newWorkstream();
    expect((await act(id, 'archive')).status).toBe(200);
    const { status, body } = await act(id, 'reopen');
    expect(status).toBe(200);
    const ws = (body as WorkstreamDetail).workstream;
    expect(ws.status).toBe('running');
    expect(ws.archivedAt).toBeNull();
  });

  it('rejects a transition the state does not allow with 409 and changes nothing', async () => {
    const id = await newWorkstream();
    await callTool(token, 'report_done', { workstream_id: id, result: 'PR #214 merged' });
    const handled = await act(id, 'handled');
    expect(handled.status).toBe(409);
    expect(handled.body.error.code).toBe('invalid_state');
    const reopenRunning = await act((await newWorkstream('Another one')), 'reopen');
    expect(reopenRunning.status).toBe(409);
    expect((await detail(id)).workstream.status).toBe('done');
  });

  it('returns 404 for an unknown workstream and 400 for an unknown action', async () => {
    expect((await act('no-such-id', 'handled')).status).toBe(404);
    const id = await newWorkstream();
    const bad = await postJson(`/api/workstreams/${id}/action`, { action: 'delete' }, seed.cookie);
    expect(bad.status).toBe(400);
    expect((await detail(id)).workstream.status).toBe('running');
  });
});

describe('CSRF and auth', () => {
  it('returns 403 when X-Requested-With is missing, and does not change the workstream', async () => {
    const id = await newWorkstream();
    await setStatus(id, 'waiting');
    const res = await SELF.fetch(
      new Request(ORIGIN + `/api/workstreams/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'mc_session=' + seed.cookie },
        body: JSON.stringify({ action: 'archive' }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('csrf');
    expect((await detail(id)).workstream.status).toBe('waiting');
  });

  it('returns 403 when X-Requested-With has the wrong value', async () => {
    const id = await newWorkstream();
    const res = await SELF.fetch(
      new Request(ORIGIN + `/api/workstreams/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'mc_session=' + seed.cookie, [CSRF_HEADER]: 'curl' },
        body: JSON.stringify({ action: 'archive' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 401 for an action without a session', async () => {
    const id = await newWorkstream();
    const res = await postJson(`/api/workstreams/${id}/action`, { action: 'archive' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/workstreams/:id', () => {
  it('returns the timeline, including the person action update', async () => {
    const id = await newWorkstream();
    await callTool(token, 'report_milestone', { workstream_id: id, note: 'tests passing' });
    await callTool(token, 'report_waiting', { workstream_id: id, needed: 'approve $214' });
    expect((await act(id, 'handled')).status).toBe(200);

    const d = await detail(id);
    expect(d.workstream.id).toBe(id);
    expect(d.project.name).toBe('Website');
    expect(d.updates.map((u) => [u.kind, u.actor])).toEqual([
      ['started', 'agent'],
      ['milestone', 'agent'],
      ['waiting', 'agent'],
      ['action', 'person'],
    ]);
    const milestone = d.updates[1];
    expect(await openField(milestone?.bodyEnc ?? '', seed.privateKey)).toBe('tests passing');
    const action = d.updates[3];
    expect(await openField(action?.bodyEnc ?? '', seed.privateKey)).toBe('Handled');
  });

  it('returns 404 for an unknown workstream', async () => {
    const res = await apiFetch('/api/workstreams/nope', {}, seed.cookie);
    expect(res.status).toBe(404);
  });

  it('returns 401 without a session', async () => {
    const id = await newWorkstream();
    const res = await apiFetch('/api/workstreams/' + id);
    expect(res.status).toBe(401);
  });
});
