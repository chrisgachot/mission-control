/** projects table queries. */
import { PROJECT_COLUMNS, mapProject } from './rows.ts';
import type { ProjectDbRow } from './rows.ts';
import type { ProjectRow } from '../types.ts';

/** All projects, non-archived first, then by sort order and age. */
export async function listProjects(db: D1Database): Promise<ProjectRow[]> {
  const res = await db
    .prepare(
      'SELECT ' + PROJECT_COLUMNS + ' FROM projects ORDER BY (archived_at IS NOT NULL), sort_order, created_at, rowid',
    )
    .all<ProjectDbRow>();
  return res.results.map(mapProject);
}

export async function listActiveProjects(db: D1Database): Promise<ProjectRow[]> {
  const res = await db
    .prepare('SELECT ' + PROJECT_COLUMNS + ' FROM projects WHERE archived_at IS NULL ORDER BY sort_order, created_at, rowid')
    .all<ProjectDbRow>();
  return res.results.map(mapProject);
}

/** Non-archived projects that live in this space (not mirrors of a shared space's projects). */
export async function listActiveLocalProjects(db: D1Database): Promise<ProjectRow[]> {
  const res = await db
    .prepare(
      'SELECT ' +
        PROJECT_COLUMNS +
        ' FROM projects WHERE archived_at IS NULL AND remote_space_id IS NULL ORDER BY sort_order, created_at, rowid',
    )
    .all<ProjectDbRow>();
  return res.results.map(mapProject);
}

export async function getProject(db: D1Database, id: string): Promise<ProjectRow | null> {
  const row = await db
    .prepare('SELECT ' + PROJECT_COLUMNS + ' FROM projects WHERE id = ?1')
    .bind(id)
    .first<ProjectDbRow>();
  return row ? mapProject(row) : null;
}

/** True when another non-archived project already has this name (case-insensitive). */
export async function activeNameTaken(db: D1Database, name: string, exceptId: string | null): Promise<boolean> {
  const res = await db
    .prepare('SELECT id, name FROM projects WHERE archived_at IS NULL')
    .all<{ id: string; name: string }>();
  const wanted = name.toLowerCase();
  return res.results.some((r) => r.id !== exceptId && r.name.trim().toLowerCase() === wanted);
}

export async function createProject(db: D1Database, name: string, now: number): Promise<ProjectRow> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO projects (id, name, sort_order, created_at) ' +
        'VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects), ?3)',
    )
    .bind(id, name, now)
    .run();
  const created = await getProject(db, id);
  if (!created) throw new Error('project insert failed');
  return created;
}

export interface ProjectPatch {
  name?: string;
  archived?: boolean;
  sortOrder?: number;
}

export async function updateProject(db: D1Database, id: string, patch: ProjectPatch, now: number): Promise<ProjectRow | null> {
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?' + (binds.length + 1));
    binds.push(patch.name);
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?' + (binds.length + 1));
    binds.push(patch.sortOrder);
  }
  if (patch.archived !== undefined) {
    sets.push('archived_at = ?' + (binds.length + 1));
    binds.push(patch.archived ? now : null);
  }
  if (sets.length > 0) {
    binds.push(id);
    // `sets` holds only fixed column fragments with numbered placeholders; all values are bound.
    await db
      .prepare('UPDATE projects SET ' + sets.join(', ') + ' WHERE id = ?' + binds.length)
      .bind(...binds)
      .run();
  }
  return getProject(db, id);
}

/**
 * Keeps a local row for a project that lives in a shared space, so workstreams (which need a local
 * project FK) can point at it. Updates the name when the shared space renamed it; never unarchives.
 */
export async function upsertMirrorProjects(
  db: D1Database,
  remoteSpaceId: string,
  remote: ReadonlyArray<{ id: string; name: string }>,
  now: number,
): Promise<void> {
  if (remote.length === 0) return;
  const stmts = remote.map((p) =>
    db
      .prepare(
        'INSERT INTO projects (id, name, remote_space_id, remote_project_id, sort_order, created_at) ' +
          'VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects), ?5) ' +
          'ON CONFLICT(remote_space_id, remote_project_id) DO UPDATE SET name = excluded.name',
      )
      .bind(crypto.randomUUID(), p.name, remoteSpaceId, p.id, now),
  );
  await db.batch(stmts);
}
