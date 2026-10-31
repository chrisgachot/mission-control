/**
 * SQL for the auth-adjacent tables (Security track): users, credentials, challenges, sessions,
 * space_keys, wrapped_keys, member_tokens, invites, remote_spaces (+ revoking connector_tokens on
 * member removal, + space_meta.setup_complete).
 *
 * Rules followed throughout:
 *  - Every value goes through prepare(...).bind(...). No string interpolation into SQL, ever.
 *  - Multi-row state changes that must be all-or-nothing go through db.batch(), which D1 runs as a
 *    single transaction (any failing statement rolls back the whole batch).
 *  - Races (two first-run registrations, two claims of one invite, two setups) are closed in SQL
 *    with conditional INSERT ... SELECT ... WHERE [NOT] EXISTS / UPDATE ... WHERE, and the caller
 *    checks meta.changes, instead of check-then-act in JavaScript.
 *  - Rows are not deleted except where docs/ARCHITECTURE.md allows: sessions (logout/removal),
 *    challenges (on use/expiry), a removed member's wrapped_keys, and remote_spaces (no soft-delete
 *    column exists; see docs/progress/security.md).
 */
import type { Role, WrappedKey } from '../types.ts';

type DB = D1Database;

// ---------------------------------------------------------------- users

export interface UserRow {
  id: string;
  handle: string;
  role: Role;
  public_key: string | null;
  created_at: number;
  removed_at: number | null;
}

export async function countUsers(db: DB): Promise<number> {
  // Counts removed users too: "users is empty" must mean "nobody ever registered", otherwise removing
  // the last member of a shared space would reopen first-run registration to anyone.
  const r = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getActiveUser(db: DB, id: string): Promise<UserRow | null> {
  return db
    .prepare('SELECT id, handle, role, public_key, created_at, removed_at FROM users WHERE id = ? AND removed_at IS NULL')
    .bind(id)
    .first<UserRow>();
}

export async function listUsers(db: DB): Promise<UserRow[]> {
  const r = await db.prepare('SELECT id, handle, role, public_key, created_at, removed_at FROM users ORDER BY created_at').all<UserRow>();
  return r.results;
}

// ---------------------------------------------------------------- credentials

export interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  prf_supported: number;
  created_at: number;
  last_used_at: number | null;
}

export async function getCredential(db: DB, id: string): Promise<CredentialRow | null> {
  return db
    .prepare('SELECT id, user_id, public_key, counter, transports, prf_supported, created_at, last_used_at FROM credentials WHERE id = ?')
    .bind(id)
    .first<CredentialRow>();
}

export async function credentialBelongsTo(db: DB, credentialId: string, userId: string): Promise<boolean> {
  const r = await db.prepare('SELECT 1 AS ok FROM credentials WHERE id = ? AND user_id = ?').bind(credentialId, userId).first<{ ok: number }>();
  return r != null;
}

/** After a verified login: store the new signature counter; upgrade prf_supported (never downgrade). */
export async function updateCredentialAfterLogin(db: DB, id: string, counter: number, now: number, prfSeen: boolean): Promise<void> {
  await db
    .prepare('UPDATE credentials SET counter = ?, last_used_at = ?, prf_supported = CASE WHEN ? = 1 THEN 1 ELSE prf_supported END WHERE id = ?')
    .bind(counter, now, prfSeen ? 1 : 0, id)
    .run();
}

// ---------------------------------------------------------------- challenges

export interface ChallengeRow {
  challenge: string;
  user_id: string | null;
  expires_at: number;
}

export async function purgeExpiredChallenges(db: DB, now: number): Promise<void> {
  await db.prepare('DELETE FROM challenges WHERE expires_at <= ?').bind(now).run();
}

export async function insertChallenge(
  db: DB,
  c: { id: string; kind: 'register' | 'login'; userId: string | null; challenge: string; expiresAt: number },
): Promise<void> {
  await db
    .prepare('INSERT INTO challenges (id, kind, user_id, challenge, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(c.id, c.kind, c.userId, c.challenge, c.expiresAt)
    .run();
}

/**
 * Single-use: DELETE ... RETURNING atomically removes the row and hands it back, so two concurrent
 * verifies with the same challenge id cannot both get it. Expiry is checked by the caller on the
 * returned row, so an expired challenge is also burned rather than left behind.
 */
export async function consumeChallenge(db: DB, id: string, kind: 'register' | 'login'): Promise<ChallengeRow | null> {
  return db
    .prepare('DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING challenge, user_id, expires_at')
    .bind(id, kind)
    .first<ChallengeRow>();
}

// ---------------------------------------------------------------- registration (user + credential + session, atomically)

export interface NewRegistration {
  userId: string;
  handle: string;
  role: Role;
  now: number;
  credential: { id: string; publicKey: string; counter: number; transports: string | null; prfSupported: boolean };
  session: { idHash: string; expiresAt: number };
  /** Set for invite claims; null for first-run registration. */
  inviteId: string | null;
  /** sha256B64u(inviteClaim) from the request; required when inviteId is set. */
  inviteClaimHash: string | null;
}

/**
 * THE invite guard (review 1, findings 1, 2, 8). One SQL predicate, used by the registration pre-checks
 * (options and verify) and inside the registration transaction, so they can never disagree:
 *   - the caller proved knowledge of the fragment secret: claim_hash matches sha256(inviteClaim);
 *   - unclaimed;
 *   - unexpired at the time of THIS request (the verify request's own clock inside the transaction);
 *   - its creator is still active (removing an admin kills the invites they made);
 *   - it carries the space's current key, checked in SQL so a rotation that commits between the
 *     pre-check and the batch still wins.
 * Binds, in order: inviteId, claimHash, now. The table alias is `i`.
 */
const USABLE_INVITE_WHERE =
  'i.id = ? AND i.claim_hash = ? AND i.claimed_by IS NULL AND i.expires_at > ? ' +
  'AND EXISTS (SELECT 1 FROM users cu WHERE cu.id = i.created_by AND cu.removed_at IS NULL) ' +
  'AND i.key_id = (SELECT sk.id FROM space_keys sk WHERE sk.retired_at IS NULL ORDER BY sk.created_at DESC, sk.rowid DESC LIMIT 1)';

/** The invite's role if it is usable right now with this claim proof, else null. */
export async function findUsableInvite(db: DB, inviteId: string, claimHash: string, now: number): Promise<{ role: string } | null> {
  return db.prepare(`SELECT i.role AS role FROM invites i WHERE ${USABLE_INVITE_WHERE}`).bind(inviteId, claimHash, now).first<{ role: string }>();
}

/**
 * Create the user, their first credential and a session in one transaction.
 *
 * First run (inviteId null): the user row is only inserted WHERE NOT EXISTS (SELECT 1 FROM users), so
 * if two people race the empty deployment, exactly one wins.
 * Invite: the user row is only inserted if USABLE_INVITE_WHERE holds (claim proof, unclaimed, unexpired,
 * active creator, current key), with the role read from the invite row, and the invite is marked claimed
 * in the same transaction, so an invite can be used once and only by someone holding its secret.
 * The credential and session inserts are conditioned on the user row existing, so a lost race leaves
 * nothing behind. Returns true if the user was created.
 */
export async function registerUser(db: DB, r: NewRegistration): Promise<boolean> {
  const userInsert =
    r.inviteId === null
      ? db
          .prepare(
            'INSERT INTO users (id, handle, role, public_key, created_at, removed_at) SELECT ?, ?, ?, NULL, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM users)',
          )
          .bind(r.userId, r.handle, r.role, r.now)
      : db
          .prepare(
            `INSERT INTO users (id, handle, role, public_key, created_at, removed_at) SELECT ?, ?, i.role, NULL, ?, NULL FROM invites i WHERE ${USABLE_INVITE_WHERE}`,
          )
          // The role is taken from the invite row inside the guarded statement, not from the caller.
          .bind(r.userId, r.handle, r.now, r.inviteId, r.inviteClaimHash ?? '', r.now);

  const stmts: D1PreparedStatement[] = [userInsert];
  if (r.inviteId !== null) {
    stmts.push(
      db
        // Mark claimed only if the guarded user insert above created our user in this transaction.
        .prepare('UPDATE invites SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND created_at = ?)')
        .bind(r.userId, r.now, r.inviteId, r.userId, r.now),
    );
  }
  stmts.push(
    db
      .prepare(
        'INSERT INTO credentials (id, user_id, public_key, counter, transports, prf_supported, created_at, last_used_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)',
      )
      .bind(r.credential.id, r.userId, r.credential.publicKey, r.credential.counter, r.credential.transports, r.credential.prfSupported ? 1 : 0, r.now, r.now, r.userId),
    db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)')
      .bind(r.session.idHash, r.userId, r.now, r.session.expiresAt, r.userId),
  );
  const results = await db.batch(stmts);
  return (results[0]?.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- sessions

export interface SessionUser {
  id: string;
  handle: string;
  role: Role;
}

export async function insertSession(db: DB, idHash: string, userId: string, now: number, expiresAt: number): Promise<void> {
  await db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(idHash, userId, now, expiresAt).run();
}

/** The live user behind a session hash: session unexpired AND user not removed. */
export async function getSessionUser(db: DB, idHash: string, now: number): Promise<SessionUser | null> {
  return db
    .prepare(
      'SELECT u.id AS id, u.handle AS handle, u.role AS role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.removed_at IS NULL',
    )
    .bind(idHash, now)
    .first<SessionUser>();
}

export async function deleteSession(db: DB, idHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(idHash).run();
}

export async function deleteExpiredSession(db: DB, idHash: string, now: number): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ? AND expires_at <= ?').bind(idHash, now).run();
}

// ---------------------------------------------------------------- space keys

export interface SpaceKeyRow {
  id: string;
  public_key: string;
  created_at: number;
  retired_at: number | null;
}

export async function getCurrentSpaceKey(db: DB): Promise<SpaceKeyRow | null> {
  return db
    .prepare('SELECT id, public_key, created_at, retired_at FROM space_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .first<SpaceKeyRow>();
}

export async function listSpaceKeys(db: DB): Promise<SpaceKeyRow[]> {
  const r = await db.prepare('SELECT id, public_key, created_at, retired_at FROM space_keys ORDER BY created_at').all<SpaceKeyRow>();
  return r.results;
}

export async function countSpaceKeys(db: DB): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM space_keys').first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------- wrapped keys

/**
 * One row to insert into wrapped_keys. `columnKeyId` is what goes in the key_id column, which has a
 * foreign key to space_keys. For wraps of a space key it equals wrapped.kid. For wraps of the user's own
 * key ("user:<id>") or of a remote shared space's key, there is no local space_keys row, so the caller
 * passes the local space kid in effect at the time instead. WrappedKey.kid (inside the JSON, and bound
 * into the ciphertext as AES-GCM additional data) is always the authoritative key id.
 */
export interface WrappedInsert {
  id: string;
  userId: string;
  columnKeyId: string;
  kind: 'prf' | 'recovery' | 'user_pub';
  credentialId: string | null;
  wrapped: WrappedKey;
  now: number;
}

/**
 * Insert one wrapped_keys row. With `guard`, the insert only happens if the space key `guard.kid` exists
 * AND was created at `guard.createdAt` AND is live, i.e. only if this very request just inserted it.
 * Setup and rotation use the guard so that a client re-sending an existing kid cannot attach wraps to,
 * or retire keys around, a key it did not just create.
 */
function wrappedInsertStmt(db: DB, w: WrappedInsert, guard?: { kid: string; createdAt: number; publicKey: string }): D1PreparedStatement {
  const base = 'INSERT INTO wrapped_keys (id, user_id, key_id, wrap_kind, credential_id, wrapped, created_at) SELECT ?, ?, ?, ?, ?, ?, ?';
  const values = [w.id, w.userId, w.columnKeyId, w.kind, w.credentialId, JSON.stringify(w.wrapped), w.now] as const;
  if (guard) {
    return db
      .prepare(`${base} WHERE EXISTS (SELECT 1 FROM space_keys WHERE id = ? AND created_at = ? AND public_key = ? AND retired_at IS NULL)`)
      .bind(...values, guard.kid, guard.createdAt, guard.publicKey);
  }
  return db.prepare(`${base} WHERE EXISTS (SELECT 1 FROM space_keys WHERE id = ?)`).bind(...values, w.columnKeyId);
}

/** SQL fragment + binds: "the key this request inserted exists". Used to guard follow-on statements. */
const OWN_KEY_EXISTS = 'EXISTS (SELECT 1 FROM space_keys WHERE id = ? AND created_at = ? AND public_key = ? AND retired_at IS NULL)';

export interface WrappedRow {
  id: string;
  key_id: string;
  wrap_kind: 'prf' | 'recovery' | 'user_pub';
  credential_id: string | null;
  wrapped: string;
  created_at: number;
}

export async function listWrappedForUser(db: DB, userId: string): Promise<WrappedRow[]> {
  const r = await db
    .prepare('SELECT id, key_id, wrap_kind, credential_id, wrapped, created_at FROM wrapped_keys WHERE user_id = ? ORDER BY created_at')
    .bind(userId)
    .all<WrappedRow>();
  return r.results;
}

export async function insertWrapped(db: DB, rows: WrappedInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(rows.map((w) => wrappedInsertStmt(db, w)));
}

/** POST /api/keys/import: store re-wrapped copies, and set users.public_key only if it is not set yet. */
export async function importWrapped(db: DB, userId: string, userPublicKey: string | null, rows: WrappedInsert[]): Promise<void> {
  const stmts: D1PreparedStatement[] = rows.map((w) => wrappedInsertStmt(db, w));
  if (userPublicKey !== null) {
    stmts.push(db.prepare('UPDATE users SET public_key = ? WHERE id = ? AND public_key IS NULL').bind(userPublicKey, userId));
  }
  if (stmts.length > 0) await db.batch(stmts);
}

export async function getUserPublicKey(db: DB, userId: string): Promise<string | null> {
  const r = await db.prepare('SELECT public_key FROM users WHERE id = ?').bind(userId).first<{ public_key: string | null }>();
  return r?.public_key ?? null;
}

/**
 * First key setup, atomically:
 *  1. insert the space key only if no space key exists yet (so setup can happen once),
 *  2. set the caller's users.public_key (only if still null, and only if step 1 inserted our kid),
 *  3. insert the wrapped copies (conditioned on our kid existing via the FK-ish EXISTS),
 *  4. mark space_meta.setup_complete = '1'.
 * Returns false if another setup won (step 1 inserted nothing); then steps 2-4 were no-ops too,
 * except step 4 which is idempotent.
 */
export async function setupFirstKey(
  db: DB,
  a: { kid: string; spacePublicKey: string; userId: string; userPublicKey: string; now: number; wrapped: WrappedInsert[] },
): Promise<boolean> {
  const g = { kid: a.kid, createdAt: a.now, publicKey: a.spacePublicKey };
  const guard = [g.kid, g.createdAt, g.publicKey] as const;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO space_keys (id, public_key, created_at, retired_at) SELECT ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM space_keys)')
      .bind(a.kid, a.spacePublicKey, a.now),
    db
      .prepare(`UPDATE users SET public_key = ? WHERE id = ? AND public_key IS NULL AND ${OWN_KEY_EXISTS}`)
      .bind(a.userPublicKey, a.userId, ...guard),
    ...a.wrapped.map((w) => wrappedInsertStmt(db, w, g)),
    db
      // SQLite needs a WHERE on INSERT ... SELECT ... ON CONFLICT to parse the upsert; the guard provides it.
      .prepare(`INSERT INTO space_meta (key, value) SELECT 'setup_complete', '1' WHERE ${OWN_KEY_EXISTS} ON CONFLICT(key) DO UPDATE SET value = '1'`)
      .bind(...guard),
  ];
  const results = await db.batch(stmts);
  return (results[0]?.meta.changes ?? 0) === 1;
}

/**
 * Rotation, atomically: insert the new key, retire every other live key, store the new wraps (for the
 * caller and for each remaining member), and expire outstanding unclaimed invites (they carry the old
 * key, so a new member claiming one would only get a retired key).
 */
export async function rotateKey(
  db: DB,
  a: { kid: string; publicKey: string; now: number; wrapped: WrappedInsert[] },
): Promise<boolean> {
  const g = { kid: a.kid, createdAt: a.now, publicKey: a.publicKey };
  const guard = [g.kid, g.createdAt, g.publicKey] as const;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO space_keys (id, public_key, created_at, retired_at) SELECT ?, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM space_keys WHERE id = ?)')
      .bind(a.kid, a.publicKey, a.now, a.kid),
    // Only retire the old keys if the new key really is ours; otherwise a reused kid could leave the
    // space with no live key at all.
    db.prepare(`UPDATE space_keys SET retired_at = ? WHERE retired_at IS NULL AND id != ? AND ${OWN_KEY_EXISTS}`).bind(a.now, a.kid, ...guard),
    ...a.wrapped.map((w) => wrappedInsertStmt(db, w, g)),
    db
      .prepare(`UPDATE invites SET expires_at = ? WHERE claimed_by IS NULL AND expires_at > ? AND ${OWN_KEY_EXISTS}`)
      .bind(a.now, a.now, ...guard),
  ];
  const results = await db.batch(stmts);
  return (results[0]?.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- members (removal)

/**
 * Remove a member, atomically: mark removed_at, end their sessions, revoke their member tokens and
 * connector tokens, delete their wrapped keys, expire the unclaimed invites they created. Deleting wrapped keys stops the server from handing
 * them out again; it does NOT take back keys the member already unwrapped, which is why the admin's
 * browser must rotate the space key right after (the API response says so).
 */
export async function removeMember(db: DB, userId: string, now: number): Promise<boolean> {
  const results = await db.batch([
    db.prepare('UPDATE users SET removed_at = ? WHERE id = ? AND removed_at IS NULL').bind(now, userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('UPDATE member_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, userId),
    db.prepare('UPDATE connector_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, userId),
    db.prepare('DELETE FROM wrapped_keys WHERE user_id = ?').bind(userId),
    // Invites this person created and nobody has claimed yet die with them (review 1, finding 2). The
    // registration guard also requires an active creator, so this is belt and braces.
    db.prepare('UPDATE invites SET expires_at = ? WHERE created_by = ? AND claimed_by IS NULL AND expires_at > ?').bind(now, userId, now),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------- member tokens

/** Mint a member token for a user, revoking any earlier live ones (one live forwarding token per member). */
export async function replaceMemberToken(db: DB, a: { id: string; userId: string; tokenHash: string; now: number }): Promise<void> {
  await db.batch([
    db.prepare('UPDATE member_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(a.now, a.userId),
    db.prepare('INSERT INTO member_tokens (id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?)').bind(a.id, a.userId, a.tokenHash, a.now),
  ]);
}

// ---------------------------------------------------------------- invites

export interface InviteRow {
  id: string;
  created_by: string;
  key_id: string;
  wrapped_key: string;
  role: string;
  expires_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
}

export async function insertInvite(
  db: DB,
  i: { id: string; createdBy: string; keyId: string; wrapped: WrappedKey; claimHash: string; role: Role; expiresAt: number },
): Promise<void> {
  await db
    .prepare('INSERT INTO invites (id, created_by, key_id, wrapped_key, claim_hash, role, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(i.id, i.createdBy, i.keyId, JSON.stringify(i.wrapped), i.claimHash, i.role, i.expiresAt)
    .run();
}

export async function getInvite(db: DB, id: string): Promise<InviteRow | null> {
  return db
    .prepare('SELECT id, created_by, key_id, wrapped_key, role, expires_at, claimed_by, claimed_at FROM invites WHERE id = ?')
    .bind(id)
    .first<InviteRow>();
}

// ---------------------------------------------------------------- space_meta

export async function getMeta(db: DB, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM space_meta WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

// ---------------------------------------------------------------- remote spaces (personal copy)

export interface RemoteSpaceRow {
  id: string;
  name: string;
  base_url: string;
  created_at: number;
  last_sync_at: number | null;
  last_error: string | null;
}

/** Never selects member_token: the plaintext bearer token stays in the Worker, it is not sent to browsers. */
export async function listRemoteSpaces(db: DB): Promise<RemoteSpaceRow[]> {
  const r = await db
    .prepare('SELECT id, name, base_url, created_at, last_sync_at, last_error FROM remote_spaces WHERE removed_at IS NULL ORDER BY created_at')
    .all<RemoteSpaceRow>();
  return r.results;
}

export async function getRemoteSpaceByBaseUrl(db: DB, baseUrl: string): Promise<RemoteSpaceRow | null> {
  return db
    .prepare('SELECT id, name, base_url, created_at, last_sync_at, last_error FROM remote_spaces WHERE base_url = ? AND removed_at IS NULL')
    .bind(baseUrl)
    .first<RemoteSpaceRow>();
}

export async function insertRemoteSpace(db: DB, r: { id: string; name: string; baseUrl: string; memberToken: string; now: number }): Promise<void> {
  await db
    .prepare('INSERT INTO remote_spaces (id, name, base_url, member_token, created_at, last_sync_at, last_error, removed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)')
    .bind(r.id, r.name, r.baseUrl, r.memberToken, r.now, r.now)
    .run();
}

export async function updateRemoteSpaceToken(db: DB, r: { id: string; name: string; memberToken: string; now: number }): Promise<void> {
  await db
    .prepare('UPDATE remote_spaces SET name = ?, member_token = ?, last_sync_at = ?, last_error = NULL WHERE id = ?')
    .bind(r.name, r.memberToken, r.now, r.id)
    .run();
}

/** Non-archived projects that still mirror this shared space. Archived mirrors do not block removal. */
export async function countProjectsForRemote(db: DB, remoteSpaceId: string): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE remote_space_id = ? AND archived_at IS NULL')
    .bind(remoteSpaceId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Soft delete: sets removed_at. The row stays (rule: never delete), and every read filters it out. */
export async function deleteRemoteSpace(db: DB, id: string, now: number = Date.now()): Promise<boolean> {
  const r = await db.prepare('UPDATE remote_spaces SET removed_at = ? WHERE id = ? AND removed_at IS NULL').bind(now, id).run();
  return (r.meta.changes ?? 0) === 1;
}
