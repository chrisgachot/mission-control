// /api/remote/* on a shared copy: bearer member tokens, forwarding ingest (docs/ARCHITECTURE.md section 5).
// The personal copy is simulated by calling these routes with a member token and envelopes sealed to the
// shared space's key, which is exactly what forward.ts sends.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardSlice, IngestEvent, SpaceInfo } from '../src/types.ts';
import { ORIGIN, addMemberToken, addUser, openField, resetDb, sealFor, seedSpace } from './helpers.ts';
import type { Seed } from './helpers.ts';

let seed: Seed;
let memberToken: string;
let memberUserId: string;

function remote(path: string, init: RequestInit & { bearer?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.bearer) headers.set('Authorization', 'Bearer ' + init.bearer);
  return SELF.fetch(new Request(ORIGIN + path, { ...init, headers }));
}

function ingest(body: Partial<IngestEvent> | Record<string, unknown>, bearer: string | null = memberToken): Promise<Response> {
  return remote('/api/remote/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    bearer,
  });
}

beforeEach(async () => {
  await resetDb();
  seed = await seedSpace({ connectorToken: false });
  const member = await addUser('member', 'alex');
  memberUserId = member.userId;
  memberToken = await addMemberToken(memberUserId);
});

describe('member token auth', () => {
  it('GET /api/remote/space with the bearer returns SpaceInfo', async () => {
    const res = await remote('/api/remote/space', { bearer: memberToken });
    expect(res.status).toBe(200);
    const info = (await res.json()) as SpaceInfo;
    expect(info).toMatchObject({
      name: env.SPACE_NAME,
      kind: 'personal',
      setupComplete: true,
      publicKey: seed.publicKey,
      keyId: seed.kid,
    });
    expect(info.version).toEqual(expect.any(String));
  });

  it('rejects a missing, wrong or malformed bearer with 401', async () => {
    expect((await remote('/api/remote/space')).status).toBe(401);
    expect((await remote('/api/remote/space', { bearer: 'not-the-token' })).status).toBe(401);
    const res = await remote('/api/remote/space', { headers: { Authorization: memberToken } });
    expect(res.status).toBe(401);
  });

  it('rejects a revoked member token with 401', async () => {
    await env.DB.prepare('UPDATE member_tokens SET revoked_at = ?1 WHERE user_id = ?2').bind(Date.now(), memberUserId).run();
    expect((await remote('/api/remote/space', { bearer: memberToken })).status).toBe(401);
  });

  it('rejects a token whose user has been removed with 401', async () => {
    await env.DB.prepare('UPDATE users SET removed_at = ?1 WHERE id = ?2').bind(Date.now(), memberUserId).run();
    expect((await remote('/api/remote/space', { bearer: memberToken })).status).toBe(401);
  });

  it('GET /api/remote/projects lists the local, active projects', async () => {
    const res = await remote('/api/remote/projects', { bearer: memberToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { space: SpaceInfo; projects: { name: string }[] };
    expect(body.space.keyId).toBe(seed.kid);
    expect(body.projects.map((p) => p.name)).toEqual(['Website', 'Ops']);
  });
});

describe('POST /api/remote/ingest', () => {
  it('a started event creates a workstream owned by the member, with the envelope stored as sent', async () => {
    const res = await ingest({
      kind: 'started',
      source_id: 'personal-ws-1',
      project_id: seed.projects[0]?.id,
      tool: 'code',
      title_enc: await sealFor(seed, 'Draft board update'),
      link_enc: null,
      key_id: seed.kid,
      at: Date.now(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workstream_id: string };
    expect(body.workstream_id).toEqual(expect.any(String));

    const row = await env.DB.prepare('SELECT origin_user_id, external_id, key_id, title_enc, status FROM workstreams WHERE id = ?1')
      .bind(body.workstream_id)
      .first<{ origin_user_id: string; external_id: string; key_id: string; title_enc: string; status: string }>();
    expect(row).toMatchObject({ origin_user_id: memberUserId, external_id: 'personal-ws-1', key_id: seed.kid, status: 'running' });
    expect(await openField(row?.title_enc ?? '', seed.privateKey)).toBe('Draft board update');
  });

  it('a milestone with the same source_id appends to the same workstream', async () => {
    const started = await ingest({
      kind: 'started',
      source_id: 'personal-ws-2',
      project_id: seed.projects[0]?.id,
      tool: 'code',
      title_enc: await sealFor(seed, 'Fix login redirect'),
      key_id: seed.kid,
      at: Date.now(),
    });
    const { workstream_id: id } = (await started.json()) as { workstream_id: string };

    const milestone = await ingest({
      kind: 'milestone',
      source_id: 'personal-ws-2',
      project_id: seed.projects[0]?.id,
      tool: 'code',
      body_enc: await sealFor(seed, 'tests passing'),
      key_id: seed.kid,
      at: Date.now(),
    });
    expect(milestone.status).toBe(200);
    expect(((await milestone.json()) as { workstream_id: string }).workstream_id).toBe(id);

    const updates = await env.DB.prepare('SELECT kind, actor, body_enc FROM updates WHERE workstream_id = ?1 ORDER BY created_at, rowid')
      .bind(id)
      .all<{ kind: string; actor: string; body_enc: string }>();
    expect(updates.results.map((u) => [u.kind, u.actor])).toEqual([
      ['started', 'agent'],
      ['milestone', 'agent'],
    ]);
    expect(await openField(updates.results[1]?.body_enc ?? '', seed.privateKey)).toBe('tests passing');
  });

  it('a second started with the same source_id returns the existing workstream', async () => {
    const body: Partial<IngestEvent> = {
      kind: 'started',
      source_id: 'personal-ws-3',
      project_id: seed.projects[0]?.id,
      tool: 'code',
      title_enc: await sealFor(seed, 'Once only'),
      key_id: seed.kid,
      at: Date.now(),
    };
    const first = (await (await ingest(body)).json()) as { workstream_id: string };
    const second = await ingest(body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { workstream_id: string }).workstream_id).toBe(first.workstream_id);
  });

  it('works without X-Requested-With, because the remote routes are exempt from the CSRF check', async () => {
    const res = await ingest({
      kind: 'started',
      source_id: 'personal-ws-4',
      project_id: seed.projects[0]?.id,
      tool: 'chat',
      title_enc: await sealFor(seed, 'No header'),
      key_id: seed.kid,
      at: Date.now(),
    });
    expect(res.status).toBe(200);
  });

  it('a wrong bearer gets 401 and nothing is written', async () => {
    const res = await ingest(
      { kind: 'started', source_id: 'nope', project_id: seed.projects[0]?.id, tool: 'code', title_enc: await sealFor(seed, 'x'), key_id: seed.kid, at: Date.now() },
      'wrong-token',
    );
    expect(res.status).toBe(401);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM workstreams').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('an unknown key_id gets 400 unknown_key', async () => {
    const res = await ingest({
      kind: 'started',
      source_id: 'personal-ws-5',
      project_id: seed.projects[0]?.id,
      tool: 'code',
      title_enc: await sealFor(seed, 'x'),
      key_id: 'a-key-this-space-never-had',
      at: Date.now(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unknown_key');
  });

  it('an envelope claiming a different kid than key_id gets 400 bad_envelope', async () => {
    const sealed = JSON.parse(await sealFor(seed, 'x')) as Record<string, unknown>;
    sealed.kid = 'some-other-kid';
    const res = await ingest({
      kind: 'started',
      source_id: 'personal-ws-6',
      project_id: seed.projects[0]?.id,
      tool: 'code',
      title_enc: JSON.stringify(sealed),
      key_id: seed.kid,
      at: Date.now(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_envelope');
  });

  it('a started event for an unknown project gets 404', async () => {
    const res = await ingest({
      kind: 'started',
      source_id: 'personal-ws-7',
      project_id: 'no-such-project',
      tool: 'code',
      title_enc: await sealFor(seed, 'x'),
      key_id: seed.kid,
      at: Date.now(),
    });
    expect(res.status).toBe(404);
  });

  it('a milestone for a source_id never started gets 409', async () => {
    const res = await ingest({
      kind: 'milestone',
      source_id: 'never-started',
      project_id: seed.projects[0]?.id,
      tool: 'code',
      body_enc: await sealFor(seed, 'x'),
      key_id: seed.kid,
      at: Date.now(),
    });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/remote/board', () => {
  it('returns the BoardSlice with the forwarded workstream as ciphertext', async () => {
    const started = await ingest({
      kind: 'started',
      source_id: 'personal-ws-8',
      project_id: seed.projects[0]?.id,
      tool: 'code',
      title_enc: await sealFor(seed, 'Visible on the shared board'),
      key_id: seed.kid,
      at: Date.now(),
    });
    expect(started.status).toBe(200);

    const res = await remote('/api/remote/board?range=7d', { bearer: memberToken });
    expect(res.status).toBe(200);
    const slice = (await res.json()) as BoardSlice;
    expect(slice.workstreams).toHaveLength(1);
    const ws = slice.workstreams[0];
    expect(ws?.originUserId).toBe(memberUserId);
    expect(await openField(ws?.titleEnc ?? '', seed.privateKey)).toBe('Visible on the shared board');
    expect(slice.keyIds).toContain(seed.kid);
  });

  it('rejects an unknown range with 400', async () => {
    const res = await remote('/api/remote/board?range=1y', { bearer: memberToken });
    expect(res.status).toBe(400);
  });
});
