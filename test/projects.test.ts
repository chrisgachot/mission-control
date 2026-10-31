// /api/projects: list (session), create and patch (owner/admin). Archived projects drop out of list_projects.
import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectRow } from '../src/types.ts';
import { ORIGIN, addUser, apiFetch, callTool, postJson, resetDb, seedSpace } from './helpers.ts';
import type { Seed } from './helpers.ts';

let seed: Seed;

beforeEach(async () => {
  await resetDb();
  seed = await seedSpace();
});

async function listNames(): Promise<string[]> {
  const res = await apiFetch('/api/projects', {}, seed.cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { projects: ProjectRow[] };
  return body.projects.map((p) => p.name);
}

describe('GET /api/projects', () => {
  it('lists the seeded projects for a signed-in user', async () => {
    const res = await apiFetch('/api/projects', {}, seed.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: ProjectRow[] };
    expect(body.projects.map((p) => p.name)).toEqual(['Website', 'Ops']);
    expect(body.projects[0]).toMatchObject({ id: seed.projects[0]?.id, remoteSpaceId: null, archivedAt: null });
  });

  it('returns 401 without a session', async () => {
    const res = await apiFetch('/api/projects');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/projects', () => {
  it('creates a project for the owner (201) and it appears in the list', async () => {
    const res = await postJson('/api/projects', { name: 'Light Hill' }, seed.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: ProjectRow };
    expect(body.project).toMatchObject({ name: 'Light Hill', remoteSpaceId: null, archivedAt: null });
    expect(await listNames()).toEqual(['Website', 'Ops', 'Light Hill']);
  });

  it('trims the name before storing it', async () => {
    const res = await postJson('/api/projects', { name: '  Finance  ' }, seed.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: ProjectRow };
    expect(body.project.name).toBe('Finance');
  });

  it('rejects a duplicate name case-insensitively with 409', async () => {
    const res = await postJson('/api/projects', { name: 'website' }, seed.cookie);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('name_taken');
    expect(await listNames()).toEqual(['Website', 'Ops']);
  });

  it('rejects an empty name with 400', async () => {
    expect((await postJson('/api/projects', { name: '' }, seed.cookie)).status).toBe(400);
    const blank = await postJson('/api/projects', { name: '   ' }, seed.cookie);
    expect(blank.status).toBe(400);
    const body = (await blank.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toMatch(/name/i);
  });

  it('forbids a plain member from creating projects (403)', async () => {
    const member = await addUser('member', 'alex');
    const res = await postJson('/api/projects', { name: 'Sneaky' }, member.cookie);
    expect(res.status).toBe(403);
  });

  it('requires the X-Requested-With header (403)', async () => {
    const res = await SELF.fetch(
      new Request(ORIGIN + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'mc_session=' + seed.cookie },
        body: JSON.stringify({ name: 'No header' }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('archiving a project hides it from list_projects over MCP but keeps it in the dashboard list', async () => {
    const ops = seed.projects[1];
    if (!ops || !seed.connectorToken) throw new Error('seed');

    const before = await callTool(seed.connectorToken, 'list_projects', {});
    expect(before.data.projects.map((p: { name: string }) => p.name)).toEqual(['Website', 'Ops']);

    const patched = await apiFetch(`/api/projects/${ops.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    }, seed.cookie);
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { project: ProjectRow };
    expect(body.project.archivedAt).not.toBeNull();

    const after = await callTool(seed.connectorToken, 'list_projects', {});
    expect(after.data.projects.map((p: { name: string }) => p.name)).toEqual(['Website']);
    // Dashboard list still shows it, archived last.
    expect(await listNames()).toEqual(['Website', 'Ops']);

    // And report_started refuses it.
    const refused = await callTool(seed.connectorToken, 'report_started', { title: 'Hidden', project_id: ops.id, tool: 'code' });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe('unknown_project');
  });

  it('unarchiving brings the project back to list_projects', async () => {
    const ops = seed.projects[1];
    if (!ops || !seed.connectorToken) throw new Error('seed');
    const patch = (archived: boolean) =>
      apiFetch(`/api/projects/${ops.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }) }, seed.cookie);
    expect((await patch(true)).status).toBe(200);
    expect((await patch(false)).status).toBe(200);
    const out = await callTool(seed.connectorToken, 'list_projects', {});
    expect(out.data.projects.map((p: { name: string }) => p.name)).toEqual(['Website', 'Ops']);
  });

  it('returns 404 for an unknown project id', async () => {
    const res = await apiFetch('/api/projects/no-such-project', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) }, seed.cookie);
    expect(res.status).toBe(404);
  });

  it('rejects an empty patch with 400', async () => {
    const res = await apiFetch(`/api/projects/${seed.projects[0]?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }, seed.cookie);
    expect(res.status).toBe(400);
  });
});
