// GET /api/board (session): local slice, derived statuses, latest update, activity buckets.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardResponse, WorkstreamRow } from '../src/types.ts';
import { DAY_MS, apiFetch, callTool, openField, postJson, resetDb, seedSpace } from './helpers.ts';
import type { Seed } from './helpers.ts';

let seed: Seed;
let token: string;
let running: string;
let waiting: string;
let done: string;

async function getBoard(range = '7d', cookie = seed.cookie): Promise<BoardResponse> {
  const res = await apiFetch('/api/board?range=' + range, {}, cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as BoardResponse;
}

function byId(rows: WorkstreamRow[], id: string): WorkstreamRow {
  const row = rows.find((w) => w.id === id);
  if (!row) throw new Error('workstream ' + id + ' not on the board');
  return row;
}

beforeEach(async () => {
  await resetDb();
  seed = await seedSpace();
  token = seed.connectorToken as string;

  // Three workstreams through the real connector: running (code), waiting (cowork), done (code).
  const a = await callTool(token, 'report_started', {
    title: 'Draft Q4 board update',
    project_id: seed.projects[0]?.id,
    tool: 'code',
    external_id: 'sess-a',
  });
  running = a.data.workstream_id;
  await callTool(token, 'report_milestone', { workstream_id: running, note: 'Outline agreed' });

  const b = await callTool(token, 'report_started', { title: 'Choose a timeout', project_id: seed.projects[1]?.id, tool: 'cowork' });
  waiting = b.data.workstream_id;
  await callTool(token, 'report_waiting', { workstream_id: waiting, needed: 'pick a timeout' });

  const c = await callTool(token, 'report_started', { title: 'Ship login fix', project_id: seed.projects[0]?.id, tool: 'code' });
  done = c.data.workstream_id;
  await callTool(token, 'report_done', { workstream_id: done, result: 'PR #214 merged' });
});

describe('GET /api/board', () => {
  it('returns the local slice with the workstreams, derived statuses and latest updates', async () => {
    const board = await getBoard('7d');
    expect(board.range).toBe('7d');
    expect(board.space.setupComplete).toBe(true);
    expect(board.space.keyId).toBe(seed.kid);
    expect(board.remote).toEqual([]);

    const local = board.local;
    expect(local.spaceId).toBeNull();
    expect(local.projects.map((p) => p.name)).toEqual(['Website', 'Ops']);
    expect(local.workstreams).toHaveLength(3);
    expect(local.keyIds).toContain(seed.kid);

    expect(byId(local.workstreams, running)).toMatchObject({ status: 'running', derived: 'running', tool: 'code' });
    expect(byId(local.workstreams, waiting)).toMatchObject({ status: 'waiting', derived: 'waiting', tool: 'cowork' });
    expect(byId(local.workstreams, done)).toMatchObject({ status: 'done', derived: 'done', tool: 'code' });

    expect(byId(local.workstreams, running).latestUpdate?.kind).toBe('milestone');
    expect(byId(local.workstreams, waiting).latestUpdate?.kind).toBe('waiting');
    expect(byId(local.workstreams, done).latestUpdate?.kind).toBe('done');
    const latest = byId(local.workstreams, waiting).latestUpdate;
    expect(latest?.actor).toBe('agent');
    expect(await openField(latest?.bodyEnc ?? '', seed.privateKey)).toBe('pick a timeout');
  });

  it('decrypts to the reported titles with the space key', async () => {
    const board = await getBoard();
    const titles = await Promise.all(board.local.workstreams.map((w) => openField(w.titleEnc, seed.privateKey)));
    expect(titles.sort()).toEqual(['Choose a timeout', 'Draft Q4 board update', 'Ship login fix']);
  });

  it('returns activity as 7 daily buckets for the 7d range, counting agent updates per tool', async () => {
    const board = await getBoard('7d');
    const activity = board.local.activity;
    expect(activity).toHaveLength(7);
    // The last bucket ends at `now`. Agent updates: running has started+milestone (code), waiting has
    // started+waiting (cowork), done has started+done (code). So code = 4, cowork = 2.
    const last = activity[6];
    expect(last?.counts.code).toBe(4);
    expect(last?.counts.cowork).toBe(2);
    const total = activity.reduce((sum, b) => sum + Object.values(b.counts).reduce((a, n) => a + n, 0), 0);
    expect(total).toBe(6);
    for (const b of activity) expect(b.end - b.start).toBe(DAY_MS);
  });

  it('returns 24 hourly buckets for the 24h range and 30 daily buckets for 30d', async () => {
    expect((await getBoard('24h')).local.activity).toHaveLength(24);
    expect((await getBoard('30d')).local.activity).toHaveLength(30);
  });

  it('rejects an unknown range with 400', async () => {
    const res = await apiFetch('/api/board?range=2y', {}, seed.cookie);
    expect(res.status).toBe(400);
  });

  it('returns 401 without a session cookie', async () => {
    const res = await apiFetch('/api/board?range=7d');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('derives stale for a running workstream with no agent report for 8 days', async () => {
    await env.DB.prepare('UPDATE workstreams SET last_agent_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 8 * DAY_MS, running)
      .run();
    const board = await getBoard();
    const ws = byId(board.local.workstreams, running);
    expect(ws.status).toBe('running'); // stored status is unchanged; stale is derived
    expect(ws.derived).toBe('stale');
  });

  it('does not mark a snoozed workstream stale, even when its last report is 8 days old', async () => {
    const res = await postJson(`/api/workstreams/${waiting}/action`, { action: 'snooze' }, seed.cookie);
    expect(res.status).toBe(200);
    await env.DB.prepare('UPDATE workstreams SET last_agent_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 8 * DAY_MS, waiting)
      .run();
    const board = await getBoard();
    const ws = byId(board.local.workstreams, waiting);
    expect(ws.snoozedUntil).toBeGreaterThan(Date.now());
    expect(ws.derived).toBe('waiting');
  });
});
