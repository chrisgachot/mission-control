/**
 * Member-token routes on a shared copy (docs/ARCHITECTURE.md section 5):
 * GET /space, GET /projects, POST /ingest, GET /board.
 * Auth: `Authorization: Bearer <member token>`, sha256 looked up in member_tokens (not revoked).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import { apiError, readJson, waitUntilOf } from './_http.ts';
import { buildLocalSlice } from '../db/board.ts';
import { getProject, listActiveLocalProjects } from '../db/projects.ts';
import { getSpaceInfo, keyExists } from '../db/spaces.ts';
import { findMemberToken, touchMemberToken } from '../db/tokens.ts';
import type { TokenOwner } from '../db/tokens.ts';
import { applyAgentEvent, findAnyByExternalId, insertStarted } from '../db/workstreams.ts';
import { isRange } from '../status.ts';
import { TOOLS } from '../types.ts';
import type { RemoteProjectsResponse, Range } from '../types.ts';

export const router = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

async function authMember(c: Ctx): Promise<TokenOwner | Response> {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const owner = match && match[1] ? await findMemberToken(c.env.DB, match[1]) : null;
  if (!owner) return apiError(c, 401, 'unauthorized', 'Unknown or revoked member token.');
  waitUntilOf(c)(touchMemberToken(c.env.DB, owner.tokenId, Date.now()));
  return owner;
}

router.get('/space', async (c) => {
  const auth = await authMember(c);
  if (auth instanceof Response) return auth;
  return c.json(await getSpaceInfo(c.env));
});

router.get('/projects', async (c) => {
  const auth = await authMember(c);
  if (auth instanceof Response) return auth;
  const [space, projects] = await Promise.all([getSpaceInfo(c.env), listActiveLocalProjects(c.env.DB)]);
  const body: RemoteProjectsResponse = { space, projects };
  return c.json(body);
});

router.get('/board', async (c) => {
  const auth = await authMember(c);
  if (auth instanceof Response) return auth;
  const rangeParam = c.req.query('range') ?? '7d';
  if (!isRange(rangeParam)) return apiError(c, 400, 'bad_request', 'range must be 24h, 7d or 30d.');
  const range: Range = rangeParam;
  const space = await getSpaceInfo(c.env);
  return c.json(await buildLocalSlice(c.env.DB, space.name, range, Date.now()));
});

const EnvelopeText = z.string().min(2).max(16_000);

const IngestBody = z.object({
  kind: z.enum(['started', 'milestone', 'waiting', 'done']),
  source_id: z.string().min(1).max(200),
  project_id: z.string().min(1).max(100),
  tool: z.enum(TOOLS),
  title_enc: EnvelopeText.optional(),
  link_enc: EnvelopeText.nullable().optional(),
  body_enc: EnvelopeText.nullable().optional(),
  key_id: z.string().min(1).max(100),
  at: z.number().finite(),
});

/** The ciphertext is opaque to us, but it must at least look like an envelope for the claimed key. */
function looksLikeEnvelope(text: string, keyId: string): boolean {
  try {
    const e: unknown = JSON.parse(text);
    if (typeof e !== 'object' || e === null) return false;
    const o = e as Record<string, unknown>;
    return o.v === 1 && o.kid === keyId && typeof o.epk === 'string' && typeof o.iv === 'string' && typeof o.ct === 'string';
  } catch {
    return false;
  }
}

router.post('/ingest', async (c) => {
  const auth = await authMember(c);
  if (auth instanceof Response) return auth;
  const parsed = await readJson(c, IngestBody);
  if (!parsed.ok) return parsed.res;
  const ev = parsed.data;

  if (!(await keyExists(c.env.DB, ev.key_id))) {
    return apiError(c, 400, 'unknown_key', 'key_id is not a key of this space. Fetch /api/remote/space and encrypt again.');
  }
  for (const text of [ev.title_enc, ev.link_enc, ev.body_enc]) {
    if (text && !looksLikeEnvelope(text, ev.key_id)) {
      return apiError(c, 400, 'bad_envelope', 'Encrypted fields must be envelopes for key_id.');
    }
  }

  const now = Date.now();
  // ev.at is the sender's clock; staleness must not depend on it, so this space stamps its own time.
  const existing = await findAnyByExternalId(c.env.DB, auth.userId, ev.source_id, now);

  if (existing && existing.status === 'archived') {
    // The shared space archived it; later reports from the member's agent are dropped quietly.
    return c.json({ workstream_id: existing.id, ignored: true });
  }

  if (ev.kind === 'started') {
    if (existing) return c.json({ workstream_id: existing.id });
    if (!ev.title_enc) return apiError(c, 400, 'bad_request', 'title_enc is required for started.');
    const project = await getProject(c.env.DB, ev.project_id);
    if (!project || project.archivedAt !== null || project.remoteSpaceId !== null) {
      return apiError(c, 404, 'unknown_project', 'No such project in this space.');
    }
    const id = await insertStarted(c.env.DB, {
      projectId: project.id,
      tool: ev.tool,
      titleEnc: ev.title_enc,
      linkEnc: ev.link_enc ?? null,
      externalId: ev.source_id,
      keyId: ev.key_id,
      originUserId: auth.userId,
      now,
    });
    return c.json({ workstream_id: id });
  }

  if (!existing) {
    return apiError(c, 409, 'unknown_workstream', 'No started event was received for this workstream.');
  }
  await applyAgentEvent(c.env.DB, {
    workstreamId: existing.id,
    kind: ev.kind,
    bodyEnc: ev.body_enc ?? null,
    keyId: ev.key_id,
    now,
  });
  return c.json({ workstream_id: existing.id });
});
