/** Builds a BoardSlice for this space. Shared by GET /api/board and GET /api/remote/board. */
import { bucketActivity, rangeStart } from '../status.ts';
import { listProjects } from './projects.ts';
import { listAgentActivitySince, listBoardWorkstreams, listUpdatesSince } from './workstreams.ts';
import type { BoardSlice, Range } from '../types.ts';

export async function buildLocalSlice(db: D1Database, spaceName: string, range: Range, now: number): Promise<BoardSlice> {
  const since = rangeStart(range, now);
  const [projects, workstreams, updates, activityEvents] = await Promise.all([
    listProjects(db),
    listBoardWorkstreams(db, now, since),
    listUpdatesSince(db, since),
    listAgentActivitySince(db, since),
  ]);
  const keys = new Set<string>();
  for (const w of workstreams) {
    keys.add(w.keyId);
    if (w.latestUpdate?.keyId) keys.add(w.latestUpdate.keyId);
  }
  for (const u of updates) if (u.keyId) keys.add(u.keyId);
  return {
    spaceId: null,
    spaceName,
    projects,
    workstreams,
    updates,
    activity: bucketActivity(range, now, activityEvents),
    keyIds: [...keys],
  };
}
