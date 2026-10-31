/**
 * Turns a decrypted board (local slice + shared slices) into the flat model every renderer reads.
 * Pure: no DOM, no fetches, no clock (uses board.now).
 */
import { STALE_AFTER_MS } from '../../src/types.ts';
import type { ActivityBucket, ProjectRow, Range, Tool, UpdateKind } from '../../src/types.ts';
import type { DecryptedBoard, DecryptedSlice, DecryptedUpdate, DecryptedWorkstream } from './vault-types.ts';
import { DAY } from './util.ts';
import { TOOLS } from './tools.ts';
import type { UiStatus } from './tools.ts';

export interface Item {
  key: string;
  id: string;
  /** Slice this row came from: null = this space. */
  spaceId: string | null;
  /** Name of the shared space when the item lives in one (also set for local mirrors of shared projects). */
  sharedName: string | null;
  /** True when the row is owned by a shared space and cannot be actioned from here. */
  readOnly: boolean;
  title: string;
  tool: Tool;
  projectKey: string;
  status: UiStatus;
  snoozed: boolean;
  lastAt: number;
  ageMs: number;
  next: string;
  link: string | null;
  updates: DecryptedUpdate[]; // newest first, only what the board response carried
  ws: DecryptedWorkstream;
}

export interface Project {
  key: string;
  id: string;
  spaceId: string | null;
  sharedName: string | null;
  name: string;
  sortOrder: number;
}

export interface BucketEvent {
  at: number;
  text: string;
  kind: UpdateKind;
  itemKey: string;
}

export interface Bucket {
  start: number;
  end: number;
  counts: Record<Tool, number>;
  events: BucketEvent[];
}

export interface Model {
  now: number;
  range: Range;
  spaceName: string;
  items: Item[];
  itemByKey: Map<string, Item>;
  projects: Project[];
  projectByKey: Map<string, Project>;
  buckets: Bucket[];
  /** Per project key: agent updates per day for the last 30 days, oldest first (length 30). */
  pulse: Map<string, number[]>;
  remoteErrors: string[];
}

/** Fields shared by the encrypted and decrypted board shapes, so pulse can be computed without decrypting. */
interface SliceLike {
  spaceId: string | null;
  spaceName: string;
  projects: ProjectRow[];
  workstreams: ReadonlyArray<{ id: string; projectId: string; externalId: string | null; tool: Tool; archivedAt: number | null }>;
  updates: ReadonlyArray<{ workstreamId: string; actor: string; createdAt: number }>;
  error?: string | undefined;
}
interface BoardLike {
  now: number;
  local: SliceLike;
  remote: SliceLike[];
}

export const PULSE_DAYS = 30;
const emptyCounts = (): Record<Tool, number> => Object.fromEntries(TOOLS.map((t) => [t, 0])) as Record<Tool, number>;
const localKey = (id: string) => 'local:' + id;
const remoteKey = (spaceId: string, id: string) => spaceId + ':' + id;
const sliceKey = (spaceId: string | null, id: string) => (spaceId === null ? localKey(id) : remoteKey(spaceId, id));

/** Which projects and workstreams are real vs. duplicates of a local mirror. */
function resolveKeys(b: BoardLike) {
  const mirrorOfRemote = new Map<string, string>(); // "spaceId:remoteProjectId" -> local project key
  for (const p of b.local.projects) {
    if (p.remoteSpaceId && p.remoteProjectId) mirrorOfRemote.set(remoteKey(p.remoteSpaceId, p.remoteProjectId), localKey(p.id));
  }
  const localIds = new Set(b.local.workstreams.map((w) => w.id));
  const projectKeyOf = (spaceId: string | null, projectId: string): string => {
    if (spaceId === null) return localKey(projectId);
    return mirrorOfRemote.get(remoteKey(spaceId, projectId)) ?? remoteKey(spaceId, projectId);
  };
  /** A shared row whose externalId is a local workstream id is the forwarded copy of that local one. */
  const isDuplicate = (spaceId: string | null, w: { externalId: string | null }) =>
    spaceId !== null && w.externalId !== null && localIds.has(w.externalId);
  return { projectKeyOf, isDuplicate };
}

export function computePulse(b: BoardLike): Map<string, number[]> {
  const { projectKeyOf, isDuplicate } = resolveKeys(b);
  const out = new Map<string, number[]>();
  const start = b.now - PULSE_DAYS * DAY;
  for (const s of [b.local, ...b.remote]) {
    const ws = new Map(s.workstreams.map((w) => [w.id, w]));
    for (const u of s.updates) {
      if (u.actor !== 'agent' || u.createdAt < start || u.createdAt > b.now) continue;
      const w = ws.get(u.workstreamId);
      if (!w || isDuplicate(s.spaceId, w)) continue;
      const pk = projectKeyOf(s.spaceId, w.projectId);
      let arr = out.get(pk);
      if (!arr) out.set(pk, (arr = new Array<number>(PULSE_DAYS).fill(0)));
      const idx = Math.min(PULSE_DAYS - 1, Math.floor((u.createdAt - start) / DAY));
      arr[idx] = (arr[idx] ?? 0) + 1;
    }
  }
  return out;
}

const KIND_TEXT: Record<UpdateKind, string> = {
  started: 'Started',
  milestone: 'Progress reported',
  waiting: 'Waiting on you',
  done: 'Finished',
  action: 'You acted',
};

export function buildModel(board: DecryptedBoard, pulse?: Map<string, number[]>): Model {
  const now = board.now;
  const { projectKeyOf, isDuplicate } = resolveKeys(board);
  const sliceName = new Map<string, string>();
  for (const r of board.remote) if (r.spaceId) sliceName.set(r.spaceId, r.spaceName);

  // Projects
  const projects: Project[] = [];
  const archivedKeys = new Set<string>();
  const seen = new Set<string>();
  const addProject = (spaceId: string | null, p: ProjectRow, sharedName: string | null) => {
    const key = sliceKey(spaceId, p.id);
    if (p.archivedAt !== null) {
      archivedKeys.add(key);
      return;
    }
    seen.add(key);
    projects.push({ key, id: p.id, spaceId, sharedName, name: p.name, sortOrder: p.sortOrder });
  };
  for (const p of board.local.projects) {
    addProject(null, p, p.remoteSpaceId ? (sliceName.get(p.remoteSpaceId) ?? 'shared') : null);
  }
  const mirrored = new Set(projects.map((p) => p.key));
  for (const r of board.remote) {
    for (const p of r.projects) {
      if (projectKeyOf(r.spaceId, p.id) !== sliceKey(r.spaceId, p.id) && mirrored.has(projectKeyOf(r.spaceId, p.id))) continue;
      addProject(r.spaceId, p, r.spaceName);
    }
  }
  const projectByKey = new Map(projects.map((p) => [p.key, p]));

  // Items
  const items: Item[] = [];
  const slices: DecryptedSlice[] = [board.local, ...board.remote];
  for (const s of slices) {
    const updatesByWs = new Map<string, DecryptedUpdate[]>();
    for (const u of s.updates) {
      const arr = updatesByWs.get(u.workstreamId);
      if (arr) arr.push(u);
      else updatesByWs.set(u.workstreamId, [u]);
    }
    for (const w of s.workstreams) {
      if (w.archivedAt !== null || w.derived === 'archived') continue;
      if (isDuplicate(s.spaceId, w)) continue;
      const pk = projectKeyOf(s.spaceId, w.projectId);
      if (archivedKeys.has(pk) || !projectByKey.has(pk)) continue;
      const project = projectByKey.get(pk) as Project;
      const snoozed = w.snoozedUntil !== null && w.snoozedUntil > now;
      let status: UiStatus;
      if (w.derived === 'done') status = 'done';
      else if (w.derived === 'stale') status = 'stale';
      else if (w.derived === 'waiting') status = snoozed ? 'running' : 'needs';
      else status = 'running';
      const lastAt = status === 'done' ? (w.doneAt ?? w.lastAgentAt) : w.lastAgentAt;
      const ups = (updatesByWs.get(w.id) ?? []).slice().sort((a, b) => b.createdAt - a.createdAt);
      const key = sliceKey(s.spaceId, w.id);
      items.push({
        key,
        id: w.id,
        spaceId: s.spaceId,
        sharedName: s.spaceId !== null ? s.spaceName : project.sharedName,
        readOnly: s.spaceId !== null,
        title: w.title,
        tool: w.tool,
        projectKey: pk,
        status,
        snoozed: snoozed && w.derived === 'waiting',
        lastAt,
        ageMs: Math.max(0, now - lastAt),
        next: w.latestUpdate?.body ?? '',
        link: w.link,
        updates: ups,
        ws: w,
      });
    }
  }
  const itemByKey = new Map(items.map((i) => [i.key, i]));

  // Activity buckets: local server-side counts, plus shared slices recomputed from their own updates
  // so forwarded copies of this person's own work are not counted twice.
  const base = board.local.activity.length ? board.local.activity : (board.remote.find((r) => r.activity.length)?.activity ?? []);
  const buckets: Bucket[] = base.map((b: ActivityBucket) => ({ start: b.start, end: b.end, counts: { ...emptyCounts(), ...b.counts }, events: [] }));
  const bucketAt = (t: number): Bucket | undefined => {
    if (!buckets.length) return undefined;
    const first = buckets[0] as Bucket;
    const last = buckets[buckets.length - 1] as Bucket;
    if (t < first.start || t > last.end) return undefined;
    return buckets.find((b) => t >= b.start && t < b.end) ?? last;
  };
  for (const s of slices) {
    const toolOf = new Map(s.workstreams.map((w) => [w.id, w]));
    for (const u of s.updates) {
      if (u.actor !== 'agent') continue;
      const w = toolOf.get(u.workstreamId);
      if (!w || isDuplicate(s.spaceId, w)) continue;
      const bk = bucketAt(u.createdAt);
      if (!bk) continue;
      if (s.spaceId !== null && base === board.local.activity) bk.counts[w.tool] += 1;
      const itemKey = sliceKey(s.spaceId, u.workstreamId);
      if (!itemByKey.has(itemKey)) continue;
      bk.events.push({ at: u.createdAt, text: u.body || KIND_TEXT[u.kind], kind: u.kind, itemKey });
    }
  }
  for (const bk of buckets) bk.events.sort((a, b) => b.at - a.at);

  return {
    now,
    range: board.range,
    spaceName: board.local.spaceName,
    items,
    itemByKey,
    projects: projects.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    projectByKey,
    buckets,
    pulse: pulse ?? computePulse(board),
    remoteErrors: board.remote.filter((r) => r.error).map((r) => `${r.spaceName}: ${r.error}`),
  };
}

export const STATUS_ORDER: Record<UiStatus, number> = { needs: 0, stale: 1, running: 2, done: 3 };
export const sortItems = (a: Item, b: Item) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.ageMs - b.ageMs;

export const isOpen = (i: Item) => i.status !== 'done';
export const STALE_DAYS = STALE_AFTER_MS / DAY;
