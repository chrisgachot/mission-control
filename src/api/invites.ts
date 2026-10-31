/**
 * /api/invites/* (Security track). Shared spaces only. Contract: docs/ARCHITECTURE.md §3 "Shared space membership".
 *
 *   POST /           admin    { wrapped (kind 'invite', current kid), role? } -> { id, expiresAt }
 *   GET  /:id        public   -> { valid, spaceName, role, expiresAt }
 *   GET  /:id/key    session  (claimed_by must be the caller) -> { wrapped }
 *   POST /:id/claim  session  (claimed_by must be the caller) -> { memberToken, spaceName, baseUrl }
 *
 * The invite secret lives only in the link's URL fragment (never sent to any server). The server stores
 * the space private key wrapped under HKDF(secret), which it cannot open. Possession of the invite id
 * alone lets someone register (that is what the id is for) but not read anything: the key needs the
 * fragment secret. So the link as a whole must be shared privately; it expires in 7 days and works once.
 *
 * The invite is claimed (claimed_by set) atomically during /api/auth/register/verify, not here; /claim
 * mints the member token that the member's personal copy uses to forward updates.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import type { WrappedKey } from '../types.ts';
import { requireRole, requireSession } from '../middleware/session.ts';
import { getCurrentSpaceKey, getInvite, getMeta, insertInvite, replaceMemberToken } from '../auth/db.ts';
import { fail, parseBody, logEvent, wrappedKeySchema, spaceName } from '../auth/http.ts';
import { randomToken, sha256B64u, validateWrappedKey } from '../crypto/index.ts';

export const router = new Hono<AppEnv>();

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const idSchema = z.uuid();

router.post('/', requireRole(['admin']), async (c) => {
  if (c.env.SPACE_KIND !== 'shared') return fail(c, 400, 'not_shared', 'Invites exist only on a shared space.');
  const body = await parseBody(c, z.object({ wrapped: wrappedKeySchema, role: z.enum(['member', 'admin']).default('member') }));
  if (!body.ok) return body.res;
  const db = c.env.DB;
  const current = await getCurrentSpaceKey(db);
  if (!current) return fail(c, 409, 'not_setup', 'Set up the space key first.');
  const { wrapped, role } = body.data;
  if (wrapped.kind !== 'invite') return fail(c, 400, 'bad_wrap', 'Invite wraps must be of kind invite.');
  if (wrapped.kid !== current.id) return fail(c, 400, 'bad_wrap', 'Invites must carry the current space key.');

  const id = crypto.randomUUID();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  await insertInvite(db, { id, createdBy: c.get('user')!.id, keyId: current.id, wrapped, role, expiresAt });
  logEvent(c, 'invites.create', { inviteId: id, role });
  return c.json({ id, expiresAt });
});

router.get('/:id', async (c) => {
  const id = c.req.param('id');
  const name = spaceName(c, await getMeta(c.env.DB, 'name'));
  const invalid = () => c.json({ valid: false, spaceName: name, role: null, expiresAt: null });
  if (!idSchema.safeParse(id).success || c.env.SPACE_KIND !== 'shared') return invalid();
  const inv = await getInvite(c.env.DB, id);
  if (!inv) return invalid();
  const current = await getCurrentSpaceKey(c.env.DB);
  const valid = inv.claimed_by === null && inv.expires_at > Date.now() && current !== null && current.id === inv.key_id;
  if (!valid) return invalid();
  return c.json({ valid: true, spaceName: name, role: inv.role, expiresAt: inv.expires_at });
});

router.get('/:id/key', requireSession, async (c) => {
  const id = c.req.param('id');
  if (!idSchema.safeParse(id).success) return fail(c, 404, 'not_found', 'No such invite.');
  const inv = await getInvite(c.env.DB, id);
  // Same 404 for "missing" and "not yours", so ids of other people's invites are not confirmed.
  if (!inv || inv.claimed_by !== c.get('user')!.id) return fail(c, 404, 'not_found', 'No such invite.');
  let wrapped: WrappedKey;
  try {
    wrapped = validateWrappedKey(JSON.parse(inv.wrapped_key));
  } catch {
    return fail(c, 500, 'invite_corrupt', 'This invite cannot be read.');
  }
  return c.json({ wrapped });
});

router.post('/:id/claim', requireSession, async (c) => {
  if (c.env.SPACE_KIND !== 'shared') return fail(c, 400, 'not_shared', 'Invites exist only on a shared space.');
  const id = c.req.param('id');
  if (!idSchema.safeParse(id).success) return fail(c, 404, 'not_found', 'No such invite.');
  const user = c.get('user')!;
  const inv = await getInvite(c.env.DB, id);
  if (!inv || inv.claimed_by !== user.id) return fail(c, 404, 'not_found', 'No such invite.');

  // A fresh bearer token for forwarding from the member's personal copy. Only its sha256 is stored;
  // the plaintext is returned exactly once, here. Calling again revokes the previous token.
  const memberToken = randomToken(32);
  const now = Date.now();
  await replaceMemberToken(c.env.DB, { id: crypto.randomUUID(), userId: user.id, tokenHash: await sha256B64u(memberToken), now });
  logEvent(c, 'invites.claim_token', { inviteId: id, userId: user.id });
  return c.json({
    memberToken,
    spaceName: spaceName(c, await getMeta(c.env.DB, 'name')),
    baseUrl: new URL(c.req.url).origin,
  });
});
