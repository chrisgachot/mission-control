/** Raw D1 row shapes and mappers to the camelCase types in src/types.ts. Internal to src/db. */
import { deriveStatus } from '../status.ts';
import type { ProjectRow, Status, Tool, UpdateKind, Actor, UpdateRow, WorkstreamRow } from '../types.ts';

export interface ProjectDbRow {
  id: string;
  name: string;
  remote_space_id: string | null;
  remote_project_id: string | null;
  sort_order: number;
  created_at: number;
  archived_at: number | null;
}

export interface UpdateDbRow {
  id: string;
  workstream_id: string;
  kind: string;
  actor: string;
  body_enc: string | null;
  key_id: string | null;
  created_at: number;
}

/** A workstreams row joined with its latest update (columns prefixed lu_). */
export interface WorkstreamDbRow {
  id: string;
  project_id: string;
  tool: string;
  status: string;
  title_enc: string;
  link_enc: string | null;
  external_id: string | null;
  key_id: string;
  origin_user_id: string | null;
  created_at: number;
  updated_at: number;
  last_agent_at: number;
  snoozed_until: number | null;
  done_at: number | null;
  archived_at: number | null;
  lu_id: string | null;
  lu_workstream_id: string | null;
  lu_kind: string | null;
  lu_actor: string | null;
  lu_body_enc: string | null;
  lu_key_id: string | null;
  lu_created_at: number | null;
}

/** Static SQL fragments (constants, never built from input). */
export const WORKSTREAM_SELECT =
  'SELECT w.id, w.project_id, w.tool, w.status, w.title_enc, w.link_enc, w.external_id, w.key_id, w.origin_user_id, ' +
  'w.created_at, w.updated_at, w.last_agent_at, w.snoozed_until, w.done_at, w.archived_at, ' +
  'lu.id AS lu_id, lu.workstream_id AS lu_workstream_id, lu.kind AS lu_kind, lu.actor AS lu_actor, ' +
  'lu.body_enc AS lu_body_enc, lu.key_id AS lu_key_id, lu.created_at AS lu_created_at ' +
  'FROM workstreams w ' +
  'LEFT JOIN updates lu ON lu.id = (SELECT id FROM updates WHERE workstream_id = w.id ORDER BY created_at DESC, rowid DESC LIMIT 1)';

export const UPDATE_COLUMNS = 'id, workstream_id, kind, actor, body_enc, key_id, created_at';
export const PROJECT_COLUMNS = 'id, name, remote_space_id, remote_project_id, sort_order, created_at, archived_at';

export function mapProject(r: ProjectDbRow): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    remoteSpaceId: r.remote_space_id,
    remoteProjectId: r.remote_project_id,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

export function mapUpdate(r: UpdateDbRow): UpdateRow {
  return {
    id: r.id,
    workstreamId: r.workstream_id,
    kind: r.kind as UpdateKind,
    actor: r.actor as Actor,
    bodyEnc: r.body_enc,
    keyId: r.key_id,
    createdAt: r.created_at,
  };
}

export function mapWorkstream(r: WorkstreamDbRow, now: number): WorkstreamRow {
  const status = r.status as Status;
  const latest: UpdateRow | null =
    r.lu_id != null && r.lu_workstream_id != null && r.lu_kind != null && r.lu_actor != null && r.lu_created_at != null
      ? mapUpdate({
          id: r.lu_id,
          workstream_id: r.lu_workstream_id,
          kind: r.lu_kind,
          actor: r.lu_actor,
          body_enc: r.lu_body_enc,
          key_id: r.lu_key_id,
          created_at: r.lu_created_at,
        })
      : null;
  return {
    id: r.id,
    projectId: r.project_id,
    tool: r.tool as Tool,
    status,
    derived: deriveStatus({ status, lastAgentAt: r.last_agent_at, snoozedUntil: r.snoozed_until }, now),
    titleEnc: r.title_enc,
    linkEnc: r.link_enc,
    externalId: r.external_id,
    keyId: r.key_id,
    originUserId: r.origin_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastAgentAt: r.last_agent_at,
    snoozedUntil: r.snoozed_until,
    doneAt: r.done_at,
    archivedAt: r.archived_at,
    latestUpdate: latest,
    remoteSpaceId: null,
  };
}
