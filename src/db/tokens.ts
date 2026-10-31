/** Connector and member token queries. Only hashes are stored: sha256(token), base64url. */
import { b64uEncode } from './util.ts';

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return b64uEncode(new Uint8Array(digest));
}

/** 32 random bytes, base64url. */
export function newTokenValue(): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export interface TokenOwner {
  tokenId: string;
  userId: string;
  handle: string;
  role: 'owner' | 'admin' | 'member';
}

interface TokenOwnerRow {
  token_id: string;
  user_id: string;
  handle: string;
  role: 'owner' | 'admin' | 'member';
}

export async function findConnectorToken(db: D1Database, token: string): Promise<TokenOwner | null> {
  const hash = await hashToken(token);
  const row = await db
    .prepare(
      'SELECT t.id AS token_id, u.id AS user_id, u.handle AS handle, u.role AS role ' +
        'FROM connector_tokens t JOIN users u ON u.id = t.user_id ' +
        'WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND u.removed_at IS NULL',
    )
    .bind(hash)
    .first<TokenOwnerRow>();
  return row ? { tokenId: row.token_id, userId: row.user_id, handle: row.handle, role: row.role } : null;
}

export function touchConnectorToken(db: D1Database, tokenId: string, now: number): Promise<unknown> {
  return db.prepare('UPDATE connector_tokens SET last_used_at = ?1 WHERE id = ?2').bind(now, tokenId).run();
}

export async function findMemberToken(db: D1Database, token: string): Promise<TokenOwner | null> {
  const hash = await hashToken(token);
  const row = await db
    .prepare(
      'SELECT t.id AS token_id, u.id AS user_id, u.handle AS handle, u.role AS role ' +
        'FROM member_tokens t JOIN users u ON u.id = t.user_id ' +
        'WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND u.removed_at IS NULL',
    )
    .bind(hash)
    .first<TokenOwnerRow>();
  return row ? { tokenId: row.token_id, userId: row.user_id, handle: row.handle, role: row.role } : null;
}

export function touchMemberToken(db: D1Database, tokenId: string, now: number): Promise<unknown> {
  return db.prepare('UPDATE member_tokens SET last_used_at = ?1 WHERE id = ?2').bind(now, tokenId).run();
}

/** Created-at of the user's live connector token, or null when they have none. */
export async function getActiveConnectorTokenCreatedAt(db: D1Database, userId: string): Promise<number | null> {
  const row = await db
    .prepare(
      'SELECT created_at FROM connector_tokens WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
    )
    .bind(userId)
    .first<{ created_at: number }>();
  return row ? row.created_at : null;
}

/**
 * Mints a token for the user only if they have no live one (race-safe single statement).
 * Returns the plaintext token when minted, null when one already existed.
 */
export async function mintConnectorTokenIfNone(db: D1Database, userId: string, now: number): Promise<string | null> {
  const token = newTokenValue();
  const hash = await hashToken(token);
  const res = await db
    .prepare(
      'INSERT INTO connector_tokens (id, user_id, token_hash, label, created_at) ' +
        'SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM connector_tokens WHERE user_id = ?2 AND revoked_at IS NULL)',
    )
    .bind(crypto.randomUUID(), userId, hash, 'default', now)
    .run();
  return (res.meta.changes ?? 0) > 0 ? token : null;
}

/** Revokes all of the user's live connector tokens and mints a fresh one atomically. Returns the plaintext once. */
export async function rotateConnectorToken(db: D1Database, userId: string, now: number): Promise<string> {
  const token = newTokenValue();
  const hash = await hashToken(token);
  await db.batch([
    db.prepare('UPDATE connector_tokens SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL').bind(now, userId),
    db
      .prepare('INSERT INTO connector_tokens (id, user_id, token_hash, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(crypto.randomUUID(), userId, hash, 'default', now),
  ]);
  return token;
}
