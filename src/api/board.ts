/** GET /api/board?range=24h|7d|30d (session). Local slice plus each remote space's slice. */
import { Hono } from 'hono';
import type { AppEnv } from '../env.d.ts';
import { apiError, waitUntilOf } from './_http.ts';
import { buildLocalSlice } from '../db/board.ts';
import { listRemoteSpaces, getSpaceInfo, recordRemoteError, recordRemoteOk } from '../db/spaces.ts';
import type { RemoteSpaceRow } from '../db/spaces.ts';
import { requireSession } from '../middleware/session.ts';
import { isRange } from '../status.ts';
import type { BoardSlice, Range } from '../types.ts';
// Security track (review 1, finding 6): no redirects, byte-capped body. See src/remote-fetch.ts.
import { fetchRemote, parseRemoteJson, MAX_REMOTE_BOARD_BYTES } from '../remote-fetch.ts';

export const router = new Hono<AppEnv>();

const REMOTE_TIMEOUT_MS = 4000;

function failedSlice(rs: RemoteSpaceRow, error: string): BoardSlice {
  return { spaceId: rs.id, spaceName: rs.name, projects: [], workstreams: [], updates: [], activity: [], keyIds: [], error };
}

function isSlice(v: unknown): v is BoardSlice {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return Array.isArray(s.projects) && Array.isArray(s.workstreams) && Array.isArray(s.updates) && Array.isArray(s.activity) && Array.isArray(s.keyIds);
}

async function fetchRemoteSlice(rs: RemoteSpaceRow, range: Range): Promise<BoardSlice> {
  const res = await fetchRemote(rs.baseUrl + '/api/remote/board?range=' + encodeURIComponent(range), {
    headers: { Authorization: 'Bearer ' + rs.memberToken, Accept: 'application/json' },
    timeoutMs: REMOTE_TIMEOUT_MS,
    maxBytes: MAX_REMOTE_BOARD_BYTES,
  });
  if (!res.ok) throw new Error('shared space answered ' + res.status);
  const body: unknown = parseRemoteJson(res.text);
  if (!isSlice(body)) throw new Error('unexpected response from shared space');
  return {
    ...body,
    spaceId: rs.id,
    spaceName: rs.name,
    workstreams: body.workstreams.map((w) => ({ ...w, remoteSpaceId: rs.id })),
  };
}

function describeFailure(reason: unknown): string {
  if (reason instanceof Error) {
    if (reason.name === 'TimeoutError' || reason.name === 'AbortError') return 'Shared space timed out.';
    if (reason.message.startsWith('shared space answered') || reason.message.startsWith('unexpected response')) {
      return reason.message.charAt(0).toUpperCase() + reason.message.slice(1) + '.';
    }
  }
  return 'Shared space unreachable.';
}

router.get('/', requireSession, async (c) => {
  const rangeParam = c.req.query('range') ?? '7d';
  if (!isRange(rangeParam)) return apiError(c, 400, 'bad_request', 'range must be 24h, 7d or 30d.');
  const range: Range = rangeParam;
  const now = Date.now();

  const [space, remoteSpaces] = await Promise.all([getSpaceInfo(c.env), listRemoteSpaces(c.env.DB)]);
  const [local, settled] = await Promise.all([
    buildLocalSlice(c.env.DB, space.name, range, now),
    Promise.allSettled(remoteSpaces.map((rs) => fetchRemoteSlice(rs, range))),
  ]);

  const waitUntil = waitUntilOf(c);
  const remote: BoardSlice[] = settled.map((r, i) => {
    const rs = remoteSpaces[i] as RemoteSpaceRow;
    if (r.status === 'fulfilled') {
      waitUntil(recordRemoteOk(c.env.DB, rs.id, now));
      return r.value;
    }
    const error = describeFailure(r.reason);
    waitUntil(recordRemoteError(c.env.DB, rs.id, 'board fetch failed: ' + error));
    return failedSlice(rs, error);
  });

  return c.json({ now, range, space, local, remote });
});
