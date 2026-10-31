/** space_meta, space_keys (read only) and remote_spaces queries. */
import type { Bindings } from '../env.d.ts';
import type { SpaceInfo, SpaceKind } from '../types.ts';

export interface RemoteSpaceRow {
  id: string;
  name: string;
  baseUrl: string;
  /** Server-side only. Never send to the browser. */
  memberToken: string;
  createdAt: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

interface RemoteSpaceDbRow {
  id: string;
  name: string;
  base_url: string;
  member_token: string;
  created_at: number;
  last_sync_at: number | null;
  last_error: string | null;
}

function mapRemoteSpace(r: RemoteSpaceDbRow): RemoteSpaceRow {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url.replace(/\/+$/, ''),
    memberToken: r.member_token,
    createdAt: r.created_at,
    lastSyncAt: r.last_sync_at,
    lastError: r.last_error,
  };
}

const REMOTE_COLUMNS = 'id, name, base_url, member_token, created_at, last_sync_at, last_error';

export async function listRemoteSpaces(db: D1Database): Promise<RemoteSpaceRow[]> {
  const res = await db
    .prepare('SELECT ' + REMOTE_COLUMNS + ' FROM remote_spaces WHERE removed_at IS NULL ORDER BY created_at, rowid')
    .all<RemoteSpaceDbRow>();
  return res.results.map(mapRemoteSpace);
}

export async function getRemoteSpace(db: D1Database, id: string): Promise<RemoteSpaceRow | null> {
  const row = await db
    .prepare('SELECT ' + REMOTE_COLUMNS + ' FROM remote_spaces WHERE id = ?1 AND removed_at IS NULL')
    .bind(id)
    .first<RemoteSpaceDbRow>();
  return row ? mapRemoteSpace(row) : null;
}

export function recordRemoteOk(db: D1Database, id: string, now: number): Promise<unknown> {
  return db.prepare('UPDATE remote_spaces SET last_sync_at = ?1, last_error = NULL WHERE id = ?2').bind(now, id).run();
}

export function recordRemoteError(db: D1Database, id: string, message: string): Promise<unknown> {
  return db.prepare('UPDATE remote_spaces SET last_error = ?1 WHERE id = ?2').bind(message.slice(0, 300), id).run();
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM space_meta WHERE key = ?1').bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

export async function isSetupComplete(db: D1Database): Promise<boolean> {
  return (await getMeta(db, 'setup_complete')) === '1';
}

export interface CurrentKey {
  id: string;
  publicKey: string;
}

/** Newest non-retired space key, or null before setup. */
export async function getCurrentKey(db: D1Database): Promise<CurrentKey | null> {
  const row = await db
    .prepare('SELECT id, public_key FROM space_keys WHERE retired_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .first<{ id: string; public_key: string }>();
  return row ? { id: row.id, publicKey: row.public_key } : null;
}

export async function keyExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS ok FROM space_keys WHERE id = ?1').bind(id).first<{ ok: number }>();
  return row != null;
}

function parseKind(v: string): SpaceKind {
  return v === 'shared' ? 'shared' : 'personal';
}

export async function getSpaceInfo(env: Bindings): Promise<SpaceInfo> {
  const [setup, key] = await Promise.all([isSetupComplete(env.DB), getCurrentKey(env.DB)]);
  return {
    name: env.SPACE_NAME,
    kind: parseKind(env.SPACE_KIND),
    setupComplete: setup,
    publicKey: key ? key.publicKey : null,
    keyId: key ? key.id : null,
    version: env.APP_VERSION,
  };
}
