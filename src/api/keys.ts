/**
 * /api/keys/* (Security track). Contract: docs/ARCHITECTURE.md §3, §7.
 *
 * The Worker only ever stores public keys and WRAPPED private keys. It cannot open any of them: the
 * wrapping secrets (PRF outputs, recovery codes, user private keys) exist only in browsers.
 *
 *   POST /setup   owner/admin, once: first space key + caller's user key + caller's wraps
 *   POST /import  any session: store the caller's own re-wrapped copies (+ set their public key once)
 *   POST /rotate  owner/admin: new space key, wraps for self and for every remaining member, retire old
 *   GET  /        any session: all space key public info + all of the caller's wrapped keys
 *
 * kid convention (see src/crypto userKeyKid): space keys are UUIDs; the caller's own user key is
 * "user:<userId>". Wraps of keys that have no local space_keys row (the user key, or a remote shared
 * space's key imported on a personal copy) are stored with key_id = the current local kid to satisfy the
 * foreign key; the JSON's kid stays authoritative. See docs/progress/security.md "Contract gaps".
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import type { WrappedKey } from '../types.ts';
import { requireRole, requireSession } from '../middleware/session.ts';
import {
  countSpaceKeys,
  credentialBelongsTo,
  getCurrentSpaceKey,
  getUserPublicKey,
  importWrapped,
  listSpaceKeys,
  listUsers,
  listWrappedForUser,
  rotateKey,
  setupFirstKey,
  type WrappedInsert,
} from '../auth/db.ts';
import { fail, parseBody, logEvent, wrappedKeySchema, credentialIdSchema } from '../auth/http.ts';
import { isValidPublicKey, userKeyKid, validateWrappedKey } from '../crypto/index.ts';

export const router = new Hono<AppEnv>();

const publicKeySchema = z.string().min(80).max(100);
/** Upper bound on wrapped_keys rows per user, so a member cannot grow the database without limit. */
const MAX_WRAPS_PER_USER = 500;

type StoredKind = 'prf' | 'recovery' | 'user_pub';
function storedKind(w: WrappedKey): StoredKind | null {
  return w.kind === 'prf' || w.kind === 'recovery' || w.kind === 'user_pub' ? w.kind : null;
}

/** prf wraps must name a passkey of the caller's; the login endpoint returns only the used passkey's prf wraps. */
async function checkPrfCredential(db: D1Database, userId: string, wrapped: WrappedKey[], credentialId: string | undefined): Promise<string | null> {
  if (!wrapped.some((w) => w.kind === 'prf')) return null;
  if (!credentialId) return 'prf wraps need credentialId';
  if (!(await credentialBelongsTo(db, credentialId, userId))) return 'credentialId is not one of your passkeys';
  return null;
}

// ------------------------------------------------------------------ setup

router.post('/setup', requireRole(['owner', 'admin']), async (c) => {
  const body = await parseBody(
    c,
    z.object({
      // The browser picks the kid (a UUID) because the kid is bound into every wrap's AES-GCM additional
      // data, which it must compute before this call. The server only checks format and uniqueness.
      kid: z.uuid(),
      spacePublicKey: publicKeySchema,
      userPublicKey: publicKeySchema,
      credentialId: credentialIdSchema.optional(),
      wrapped: z.array(wrappedKeySchema).min(2).max(8),
    }),
  );
  if (!body.ok) return body.res;
  const user = c.get('user')!;
  const db = c.env.DB;
  const { kid, spacePublicKey, userPublicKey, credentialId, wrapped } = body.data;

  if ((await countSpaceKeys(db)) > 0) return fail(c, 409, 'already_setup', 'This space already has a key.');
  if (!(await isValidPublicKey(spacePublicKey)) || !(await isValidPublicKey(userPublicKey))) {
    return fail(c, 400, 'bad_public_key', 'Public keys must be P-256 points.');
  }

  const ownKid = userKeyKid(user.id);
  for (const w of wrapped) {
    if (!storedKind(w)) return fail(c, 400, 'bad_wrap', 'Only prf, recovery or user_pub wraps can be stored.');
    if (w.kid !== kid && w.kid !== ownKid) return fail(c, 400, 'bad_wrap', 'Wraps must be of the new space key or your own user key.');
  }
  // Guard against a client bug locking the owner out forever: both private keys must have a recovery
  // wrap (the recovery code is always generated, PRF is optional).
  const hasRecovery = (k: string) => wrapped.some((w) => w.kind === 'recovery' && w.kid === k);
  if (!hasRecovery(kid) || !hasRecovery(ownKid)) {
    return fail(c, 400, 'missing_recovery', 'Setup needs a recovery wrap of both the space key and your user key.');
  }
  const prfErr = await checkPrfCredential(db, user.id, wrapped, credentialId);
  if (prfErr) return fail(c, 400, 'bad_wrap', prfErr);

  const now = Date.now();
  const rows: WrappedInsert[] = wrapped.map((w) => ({
    id: crypto.randomUUID(),
    userId: user.id,
    columnKeyId: kid,
    kind: storedKind(w)!,
    credentialId: w.kind === 'prf' ? (credentialId ?? null) : null,
    wrapped: w,
    now,
  }));
  const ok = await setupFirstKey(db, { kid, spacePublicKey, userId: user.id, userPublicKey, now, wrapped: rows });
  if (!ok) return fail(c, 409, 'already_setup', 'This space already has a key.');
  logEvent(c, 'keys.setup', { userId: user.id, kid, wraps: rows.length });
  return c.json({ ok: true, kid });
});

// ------------------------------------------------------------------ import

router.post('/import', requireSession, async (c) => {
  const body = await parseBody(
    c,
    z.object({
      wrapped: z.array(wrappedKeySchema).min(1).max(32),
      userPublicKey: publicKeySchema.optional(),
      credentialId: credentialIdSchema.optional(),
    }),
  );
  if (!body.ok) return body.res;
  const user = c.get('user')!;
  const db = c.env.DB;
  const { wrapped, userPublicKey, credentialId } = body.data;

  const current = await getCurrentSpaceKey(db);
  if (!current) return fail(c, 409, 'not_setup', 'This space has no key yet.');

  for (const w of wrapped) {
    if (!storedKind(w)) return fail(c, 400, 'bad_wrap', 'Only prf, recovery or user_pub wraps can be stored.');
    // A "user:" kid may only be the caller's own user key, so nobody can plant a wrap that looks like
    // someone else's user key in their own list (harmless, but confusing for the browser).
    if (w.kid.startsWith('user:') && w.kid !== userKeyKid(user.id)) return fail(c, 400, 'bad_wrap', 'That user key is not yours.');
  }
  const prfErr = await checkPrfCredential(db, user.id, wrapped, credentialId);
  if (prfErr) return fail(c, 400, 'bad_wrap', prfErr);

  // users.public_key is set once and never silently replaced: rotation wraps new shared keys to it, so
  // letting a session overwrite it would let whoever holds a stolen session redirect future keys.
  if (userPublicKey !== undefined) {
    if (!(await isValidPublicKey(userPublicKey))) return fail(c, 400, 'bad_public_key', 'Public key must be a P-256 point.');
    const existing = await getUserPublicKey(db, user.id);
    if (existing !== null && existing !== userPublicKey) {
      return fail(c, 409, 'public_key_mismatch', 'Your account already has a different user key.');
    }
  }

  const existingRows = await listWrappedForUser(db, user.id);
  if (existingRows.length + wrapped.length > MAX_WRAPS_PER_USER) return fail(c, 409, 'too_many_wraps', 'Too many stored keys.');

  const localKids = new Set((await listSpaceKeys(db)).map((k) => k.id));
  const now = Date.now();
  const rows: WrappedInsert[] = wrapped.map((w) => ({
    id: crypto.randomUUID(),
    userId: user.id,
    columnKeyId: localKids.has(w.kid) ? w.kid : current.id,
    kind: storedKind(w)!,
    credentialId: w.kind === 'prf' ? (credentialId ?? null) : null,
    wrapped: w,
    now,
  }));
  await importWrapped(db, user.id, userPublicKey ?? null, rows);
  logEvent(c, 'keys.import', { userId: user.id, wraps: rows.length });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ rotate

router.post('/rotate', requireRole(['owner', 'admin']), async (c) => {
  const body = await parseBody(
    c,
    z.object({
      kid: z.uuid(),
      /** The kid the browser believes is current. Rejected if stale, so two concurrent rotations cannot interleave. */
      previousKid: z.string().min(1).max(128),
      publicKey: publicKeySchema,
      credentialId: credentialIdSchema.optional(),
      /** The caller's own wraps of the new key (prf / user_pub to self / recovery). */
      wrapped: z.array(wrappedKeySchema).min(1).max(8),
      /** One user_pub wrap of the new key per remaining member. */
      members: z.array(z.object({ userId: z.uuid(), wrapped: wrappedKeySchema })).max(500).default([]),
    }),
  );
  if (!body.ok) return body.res;
  const user = c.get('user')!;
  const db = c.env.DB;
  const { kid, previousKid, publicKey, credentialId, wrapped, members } = body.data;

  const current = await getCurrentSpaceKey(db);
  if (!current) return fail(c, 409, 'not_setup', 'This space has no key yet.');
  if (current.id !== previousKid) return fail(c, 409, 'stale_key', 'The space key changed meanwhile. Reload and try again.');
  if ((await listSpaceKeys(db)).some((k) => k.id === kid)) return fail(c, 409, 'kid_exists', 'That key id is already used.');
  if (!(await isValidPublicKey(publicKey))) return fail(c, 400, 'bad_public_key', 'Public key must be a P-256 point.');

  for (const w of wrapped) {
    if (!storedKind(w) || w.kid !== kid) return fail(c, 400, 'bad_wrap', 'Your wraps must be prf, recovery or user_pub of the new key.');
  }
  const prfErr = await checkPrfCredential(db, user.id, wrapped, credentialId);
  if (prfErr) return fail(c, 400, 'bad_wrap', prfErr);

  // Every remaining member who has a user key must get a copy, or they would silently lose access to
  // everything written after this rotation. Removed users must not get one.
  const users = await listUsers(db);
  const required = new Set(users.filter((u) => u.removed_at === null && u.public_key !== null && u.id !== user.id).map((u) => u.id));
  const seen = new Set<string>();
  for (const m of members) {
    if (m.userId === user.id) continue; // a user_pub wrap to self belongs in `wrapped`; tolerate and ignore
    if (!required.has(m.userId)) return fail(c, 400, 'bad_member', 'A wrap targets a user who is not an active member with a key.');
    if (seen.has(m.userId)) return fail(c, 400, 'bad_member', 'Duplicate wrap for one member.');
    if (m.wrapped.kind !== 'user_pub' || m.wrapped.kid !== kid) return fail(c, 400, 'bad_wrap', 'Member wraps must be user_pub of the new key.');
    seen.add(m.userId);
  }
  const missing = [...required].filter((id) => !seen.has(id));
  if (missing.length > 0) return fail(c, 400, 'rotation_incomplete', `Missing wraps for ${missing.length} member(s).`);

  const now = Date.now();
  const rows: WrappedInsert[] = [
    ...wrapped.map((w) => ({
      id: crypto.randomUUID(),
      userId: user.id,
      columnKeyId: kid,
      kind: storedKind(w)!,
      credentialId: w.kind === 'prf' ? (credentialId ?? null) : null,
      wrapped: w,
      now,
    })),
    ...members
      .filter((m) => m.userId !== user.id)
      .map((m) => ({ id: crypto.randomUUID(), userId: m.userId, columnKeyId: kid, kind: 'user_pub' as const, credentialId: null, wrapped: m.wrapped, now })),
  ];
  const ok = await rotateKey(db, { kid, publicKey, now, wrapped: rows });
  if (!ok) return fail(c, 409, 'kid_exists', 'That key id is already used.');
  logEvent(c, 'keys.rotate', { userId: user.id, kid, previousKid, members: seen.size });
  return c.json({ ok: true, kid });
});

// ------------------------------------------------------------------ list

router.get('/', requireSession, async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const keys = await listSpaceKeys(db);
  const current = keys.filter((k) => k.retired_at === null).sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const wrapped: WrappedKey[] = [];
  for (const r of await listWrappedForUser(db, user.id)) {
    try {
      wrapped.push(validateWrappedKey(JSON.parse(r.wrapped)));
    } catch {
      logEvent(c, 'keys.wrapped_row_invalid', { rowId: r.id });
    }
  }
  return c.json({
    keys: keys.map((k) => ({ id: k.id, publicKey: k.public_key, createdAt: k.created_at, retiredAt: k.retired_at })),
    currentKid: current?.id ?? null,
    userPublicKey: await getUserPublicKey(db, user.id),
    wrapped,
  });
});
