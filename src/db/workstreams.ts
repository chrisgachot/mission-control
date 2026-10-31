/** workstreams and updates queries. All values are bound; SQL text is constant. */
import { deriveStatus } from '../status.ts';
import { UPDATE_COLUMNS, WORKSTREAM_SELECT, mapUpdate, mapWorkstream } from './rows.ts';
import type { UpdateDbRow, WorkstreamDbRow } from './rows.ts';
import { escapeLike } from './util.ts';
import type { PersonAction, Status, Tool, UpdateRow, WorkstreamRow } from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getWorkstream(db: D1Database, id: string, now: number): Promise<WorkstreamRow | null> {
  const row = await db.prepare(WORKSTREAM_SELECT + ' WHERE w.id = ?1').bind(id).first<WorkstreamDbRow>();
  return row ? mapWorkstream(row, now) : null;
}

/** Newest non-archived workstream for (origin user, external id). `originUserId` null matches rows with no origin. */
export async function findByExternalId(
  db: D1Database,
  originUserId: string | null,
  externalId: string,
  now: number,
): Promise<WorkstreamRow | null> {
  const row = await db
    .prepare(
      WORKSTREAM_SELECT +
        " WHERE w.external_id = ?1 AND w.origin_user_id IS ?2 AND w.status != 'archived' ORDER BY w.created_at DESC, w.rowid DESC LIMIT 1",
    )
    .bind(externalId, originUserId)
    .first<WorkstreamDbRow>();
  return row ? mapWorkstream(row, now) : null;
}

/** Like findByExternalId but also returns archived rows (used by ingest to ignore events for archived work). */
export async function findAnyByExternalId(
  db: D1Database,
  originUserId: string | null,
  externalId: string,
  now: number,
): Promise<WorkstreamRow | null> {
  const row = await db
    .prepare(
      WORKSTREAM_SELECT +
        ' WHERE w.external_id = ?1 AND w.origin_user_id IS ?2 ORDER BY (w.status = ' +
        "'archived'), w.created_at DESC, w.rowid DESC LIMIT 1",
    )
    .bind(externalId, originUserId)
    .first<WorkstreamDbRow>();
  return row ? mapWorkstream(row, now) : null;
}

/**
 * Workstreams for the board: everything running or waiting, done ones finished since `since`,
 * archived ones archived since `archivedSince`.
 */
export async function listBoardWorkstreams(
  db: D1Database,
  now: number,
  since: number,
): Promise<WorkstreamRow[]> {
  const archivedSince = now - 30 * DAY_MS;
  const res = await db
    .prepare(
      WORKSTREAM_SELECT +
        " WHERE w.status IN ('running','waiting')" +
        " OR (w.status = 'done' AND COALESCE(w.done_at, w.updated_at) >= ?1)" +
        " OR (w.status = 'archived' AND COALESCE(w.archived_at, w.updated_at) >= ?2)" +
        ' ORDER BY w.last_agent_at DESC, w.rowid DESC',
    )
    .bind(since, archivedSince)
    .all<WorkstreamDbRow>();
  return res.results.map((r) => mapWorkstream(r, now));
}

export interface FoundWorkstream {
  id: string;
  project: string;
  tool: Tool;
  status: Status;
  stale: boolean;
  createdAt: number;
  lastAgentAt: number;
  externalId: string | null;
}

interface FoundRow {
  id: string;
  project_name: string;
  tool: string;
  status: string;
  created_at: number;
  last_agent_at: number;
  snoozed_until: number | null;
  external_id: string | null;
}

export async function findWorkstreams(
  db: D1Database,
  filters: { originUserId: string; query?: string; externalId?: string; projectId?: string; status?: Status },
  now: number,
  limit = 50,
): Promise<FoundWorkstream[]> {
  const like = filters.query ? '%' + escapeLike(filters.query.toLowerCase()) + '%' : null;
  const res = await db
    .prepare(
      'SELECT w.id, p.name AS project_name, w.tool, w.status, w.created_at, w.last_agent_at, w.snoozed_until, w.external_id ' +
        'FROM workstreams w JOIN projects p ON p.id = w.project_id ' +
        'WHERE (w.origin_user_id IS NULL OR w.origin_user_id = ?1) ' +
        'AND (?2 IS NULL OR w.external_id = ?2) ' +
        'AND (?3 IS NULL OR w.project_id = ?3) ' +
        'AND (?4 IS NULL OR w.status = ?4) ' +
        "AND (?5 IS NULL OR lower(COALESCE(w.external_id, '')) LIKE ?5 ESCAPE '\\' OR lower(p.name) LIKE ?5 ESCAPE '\\') " +
        'ORDER BY w.last_agent_at DESC, w.rowid DESC LIMIT ?6',
    )
    .bind(
      filters.originUserId,
      filters.externalId ?? null,
      filters.projectId ?? null,
      filters.status ?? null,
      like,
      limit,
    )
    .all<FoundRow>();
  return res.results.map((r) => {
    const status = r.status as Status;
    return {
      id: r.id,
      project: r.project_name,
      tool: r.tool as Tool,
      status,
      stale: deriveStatus({ status, lastAgentAt: r.last_agent_at, snoozedUntil: r.snoozed_until }, now) === 'stale',
      createdAt: r.created_at,
      lastAgentAt: r.last_agent_at,
      externalId: r.external_id,
    };
  });
}

export interface StartedInput {
  projectId: string;
  tool: Tool;
  titleEnc: string;
  linkEnc: string | null;
  externalId: string | null;
  keyId: string;
  originUserId: string | null;
  now: number;
}

/** Inserts a running workstream and its 'started' update atomically. Returns the new id. */
export async function insertStarted(db: D1Database, input: StartedInput): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO workstreams (id, project_id, tool, status, title_enc, link_enc, external_id, key_id, origin_user_id, created_at, updated_at, last_agent_at) " +
          "VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9)",
      )
      .bind(
        id,
        input.projectId,
        input.tool,
        input.titleEnc,
        input.linkEnc,
        input.externalId,
        input.keyId,
        input.originUserId,
        input.now,
      ),
    // The started update repeats the title ciphertext so the board's "latest update" always has text.
    insertUpdateStmt(db, id, 'started', 'agent', input.titleEnc, input.keyId, input.now),
  ]);
  return id;
}

export type AgentEventKind = 'milestone' | 'waiting' | 'done';

/**
 * Applies an agent report: milestone -> running (reopens a done one), waiting -> waiting (clears snooze),
 * done -> done. Always refreshes last_agent_at and appends the update. Returns the new stored status.
 */
export async function applyAgentEvent(
  db: D1Database,
  input: { workstreamId: string; kind: AgentEventKind; bodyEnc: string | null; keyId: string | null; now: number },
): Promise<Status> {
  const { workstreamId: id, kind, now } = input;
  let update: D1PreparedStatement;
  let status: Status;
  if (kind === 'milestone') {
    status = 'running';
    update = db
      .prepare(
        "UPDATE workstreams SET status = 'running', done_at = NULL, last_agent_at = ?1, updated_at = ?1 WHERE id = ?2 AND status != 'archived'",
      )
      .bind(now, id);
  } else if (kind === 'waiting') {
    status = 'waiting';
    update = db
      .prepare(
        "UPDATE workstreams SET status = 'waiting', done_at = NULL, snoozed_until = NULL, last_agent_at = ?1, updated_at = ?1 WHERE id = ?2 AND status != 'archived'",
      )
      .bind(now, id);
  } else {
    status = 'done';
    update = db
      .prepare(
        "UPDATE workstreams SET status = 'done', done_at = ?1, last_agent_at = ?1, updated_at = ?1 WHERE id = ?2 AND status != 'archived'",
      )
      .bind(now, id);
  }
  await db.batch([update, insertUpdateStmt(db, id, kind, 'agent', input.bodyEnc, input.keyId, now)]);
  return status;
}

/** Applies a person action and appends the matching 'action' update. Caller validates the transition. */
export async function applyPersonAction(
  db: D1Database,
  input: { workstreamId: string; action: PersonAction; bodyEnc: string; keyId: string; now: number },
): Promise<void> {
  const { workstreamId: id, action, now } = input;
  let update: D1PreparedStatement;
  switch (action) {
    case 'handled':
      update = db
        .prepare("UPDATE workstreams SET status = CASE WHEN status = 'waiting' THEN 'running' ELSE status END, updated_at = ?1 WHERE id = ?2")
        .bind(now, id);
      break;
    case 'snooze':
      update = db
        .prepare('UPDATE workstreams SET snoozed_until = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(now + DAY_MS, now, id);
      break;
    case 'archive':
      update = db
        .prepare("UPDATE workstreams SET status = 'archived', archived_at = ?1, updated_at = ?1 WHERE id = ?2")
        .bind(now, id);
      break;
    case 'resume':
      update = db
        .prepare("UPDATE workstreams SET status = 'running', snoozed_until = NULL, last_agent_at = ?1, updated_at = ?1 WHERE id = ?2")
        .bind(now, id);
      break;
    case 'reopen':
      update = db
        .prepare(
          "UPDATE workstreams SET status = 'running', done_at = NULL, archived_at = NULL, snoozed_until = NULL, last_agent_at = ?1, updated_at = ?1 WHERE id = ?2",
        )
        .bind(now, id);
      break;
  }
  await db.batch([update, insertUpdateStmt(db, id, 'action', 'person', input.bodyEnc, input.keyId, now)]);
}

function insertUpdateStmt(
  db: D1Database,
  workstreamId: string,
  kind: string,
  actor: string,
  bodyEnc: string | null,
  keyId: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO updates (id, workstream_id, kind, actor, body_enc, key_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(crypto.randomUUID(), workstreamId, kind, actor, bodyEnc, keyId, now);
}

export async function listUpdatesForWorkstream(db: D1Database, workstreamId: string): Promise<UpdateRow[]> {
  const res = await db
    .prepare('SELECT ' + UPDATE_COLUMNS + ' FROM updates WHERE workstream_id = ?1 ORDER BY created_at, rowid')
    .bind(workstreamId)
    .all<UpdateDbRow>();
  return res.results.map(mapUpdate);
}

/** Updates created since `since`, newest first, capped. */
export async function listUpdatesSince(db: D1Database, since: number, limit = 500): Promise<UpdateRow[]> {
  const res = await db
    .prepare('SELECT ' + UPDATE_COLUMNS + ' FROM updates WHERE created_at >= ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2')
    .bind(since, limit)
    .all<UpdateDbRow>();
  return res.results.map(mapUpdate);
}

/** Agent update timestamps with their tool, for activity bucketing. */
export async function listAgentActivitySince(db: D1Database, since: number): Promise<{ tool: Tool; at: number }[]> {
  const res = await db
    .prepare(
      "SELECT w.tool AS tool, u.created_at AS at FROM updates u JOIN workstreams w ON w.id = u.workstream_id WHERE u.actor = 'agent' AND u.created_at >= ?1",
    )
    .bind(since)
    .all<{ tool: string; at: number }>();
  return res.results.map((r) => ({ tool: r.tool as Tool, at: r.at }));
}
