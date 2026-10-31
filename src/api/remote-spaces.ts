/**
 * /api/remote-spaces/* (Security track). Personal copy, owner only. Contract: docs/ARCHITECTURE.md §3, §5, §7.
 *
 *   GET    /     -> { remoteSpaces: [{ id, name, baseUrl, createdAt, lastSyncAt, lastError }] }
 *   POST   /     { name, baseUrl, memberToken } -> { remoteSpace, space }
 *   DELETE /:id  -> { ok }   (409 if local projects still mirror it)
 *
 * The member token is a bearer credential for the shared space. It is stored in plaintext because this
 * Worker must present it (schema decision), and it is never returned to the browser by GET.
 *
 * Before storing, POST checks the token works by calling {baseUrl}/api/remote/space with it (4 s
 * timeout). baseUrl is normalized to a bare origin and must be https (http allowed only for localhost
 * / 127.0.0.1, for two local `wrangler dev` instances). Redirects are not followed, so the bearer token
 * is never re-sent to a host the owner did not type.
 *
 * DELETE is a soft delete (remote_spaces.removed_at); reads filter removed rows out.
 * A remote space with non-archived mirrored projects returns 409: archive those projects first.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import type { SpaceInfo } from '../types.ts';
import { requireRole } from '../middleware/session.ts';
import {
  countProjectsForRemote,
  deleteRemoteSpace,
  getRemoteSpaceByBaseUrl,
  insertRemoteSpace,
  listRemoteSpaces,
  updateRemoteSpaceToken,
  type RemoteSpaceRow,
} from '../auth/db.ts';
import { fail, parseBody, logEvent } from '../auth/http.ts';
import { isLocalHostname } from '../auth/sessions.ts';
import { isValidPublicKey } from '../crypto/index.ts';
import { fetchRemote, parseRemoteJson, MAX_REMOTE_RESPONSE_BYTES } from '../remote-fetch.ts';

export const router = new Hono<AppEnv>();

router.use('*', requireRole(['owner']));

const VERIFY_TIMEOUT_MS = 4000;

function toApi(r: RemoteSpaceRow) {
  return { id: r.id, name: r.name, baseUrl: r.base_url, createdAt: r.created_at, lastSyncAt: r.last_sync_at, lastError: r.last_error };
}

/** Normalize to "scheme://host[:port]" or return null if not acceptable. */
export function normalizeBaseUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const local = isLocalHostname(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null; // no credentials in the URL
  if (u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null; // a bare origin; we append /api/remote/... ourselves
  return u.origin;
}

const spaceInfoSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.literal('shared'),
  setupComplete: z.boolean(),
  publicKey: z.string().nullable(),
  keyId: z.string().max(128).nullable(),
  version: z.string().max(100),
});

router.get('/', async (c) => {
  const rows = await listRemoteSpaces(c.env.DB);
  return c.json({ remoteSpaces: rows.map(toApi) });
});

router.post('/', async (c) => {
  const body = await parseBody(
    c,
    z.object({
      name: z.string().trim().min(1).max(80).regex(/^[^\p{C}]+$/u),
      baseUrl: z.string().min(8).max(300),
      memberToken: z.string().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/),
    }),
  );
  if (!body.ok) return body.res;
  const baseUrl = normalizeBaseUrl(body.data.baseUrl);
  if (!baseUrl) return fail(c, 400, 'bad_base_url', 'Use the shared space address, like https://team.example.workers.dev');
  if (baseUrl === new URL(c.req.url).origin) return fail(c, 400, 'bad_base_url', 'That is this space, not a shared one.');

  // Verify the token against the shared space before storing anything.
  let space: SpaceInfo;
  try {
    // fetchRemote: no redirects (a 3xx throws), body capped in bytes while streaming.
    const res = await fetchRemote(`${baseUrl}/api/remote/space`, {
      headers: { Authorization: `Bearer ${body.data.memberToken}`, Accept: 'application/json' },
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxBytes: MAX_REMOTE_RESPONSE_BYTES,
    });
    if (res.status === 401 || res.status === 403) return fail(c, 400, 'remote_rejected', 'The shared space did not accept that member token.');
    if (res.status !== 200) return fail(c, 502, 'remote_unreachable', `The shared space answered ${res.status}.`);
    const parsed = spaceInfoSchema.safeParse(parseRemoteJson(res.text));
    if (!parsed.success) return fail(c, 502, 'remote_bad_response', 'That address is not a shared Mission Control space.');
    if (parsed.data.publicKey !== null && !(await isValidPublicKey(parsed.data.publicKey))) {
      return fail(c, 502, 'remote_bad_response', 'The shared space sent an invalid key.');
    }
    space = parsed.data;
  } catch {
    return fail(c, 502, 'remote_unreachable', 'Could not reach the shared space (timed out or refused).');
  }

  const db = c.env.DB;
  const now = Date.now();
  const existing = await getRemoteSpaceByBaseUrl(db, baseUrl);
  let id: string;
  if (existing) {
    // Re-connecting (new token after a re-claim): replace the token in place, keep the id and its projects.
    id = existing.id;
    await updateRemoteSpaceToken(db, { id, name: body.data.name, memberToken: body.data.memberToken, now });
  } else {
    id = crypto.randomUUID();
    await insertRemoteSpace(db, { id, name: body.data.name, baseUrl, memberToken: body.data.memberToken, now });
  }
  logEvent(c, 'remote_spaces.connect', { remoteSpaceId: id, reconnect: existing !== null });
  const row = (await listRemoteSpaces(db)).find((r) => r.id === id);
  return c.json({ remoteSpace: row ? toApi(row) : { id, name: body.data.name, baseUrl }, space });
});

router.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!z.uuid().safeParse(id).success) return fail(c, 404, 'not_found', 'No such shared space.');
  const db = c.env.DB;
  if ((await countProjectsForRemote(db, id)) > 0) {
    return fail(c, 409, 'remote_space_in_use', 'Archive the projects that mirror this shared space first, then remove it.');
  }
  const ok = await deleteRemoteSpace(db, id);
  if (!ok) return fail(c, 404, 'not_found', 'No such shared space.');
  logEvent(c, 'remote_spaces.delete', { remoteSpaceId: id });
  return c.json({ ok: true });
});
