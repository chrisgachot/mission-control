/**
 * Personal copy -> shared copy (docs/ARCHITECTURE.md section 5).
 * Nothing here throws into the caller: failures land in remote_spaces.last_error.
 */
import { encryptForKey } from './crypto/index.ts';
import { recordRemoteError, recordRemoteOk } from './db/spaces.ts';
import type { RemoteSpaceRow } from './db/spaces.ts';
import type { Bindings } from './env.d.ts';
import type { IngestEvent, ProjectRow, RemoteProjectsResponse, SpaceInfo, Tool } from './types.ts';

const FORWARD_TIMEOUT_MS = 4000;
const LIST_TIMEOUT_MS = 3000;

/** A plaintext event about a workstream in a shared project. forwardEvent encrypts it for the shared space. */
export interface ForwardEvent {
  kind: IngestEvent['kind'];
  /** The personal copy's workstream id. */
  sourceId: string;
  /** The project's id inside the shared space (projects.remote_project_id). */
  remoteProjectId: string;
  tool: Tool;
  title?: string;
  link?: string | null;
  body?: string | null;
  at: number;
}

export type ForwardResult = { ok: true } | { ok: false; error: string };

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
    return err.message.slice(0, 200);
  }
  return 'unknown error';
}

function authHeaders(rs: RemoteSpaceRow): Record<string, string> {
  return { Authorization: 'Bearer ' + rs.memberToken, Accept: 'application/json' };
}

export async function forwardEvent(env: Bindings, rs: RemoteSpaceRow, ev: ForwardEvent): Promise<ForwardResult> {
  try {
    const spaceRes = await fetch(rs.baseUrl + '/api/remote/space', {
      headers: authHeaders(rs),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!spaceRes.ok) throw new Error('shared space answered ' + spaceRes.status + ' on /space');
    const space = (await spaceRes.json()) as Partial<SpaceInfo>;
    if (!space.publicKey || !space.keyId) throw new Error('shared space has no key yet');
    const kid = space.keyId;
    const pub = space.publicKey;
    const seal = async (text: string | null | undefined): Promise<string | null> =>
      text == null ? null : JSON.stringify(await encryptForKey(kid, pub, text));

    const [titleEnc, linkEnc, bodyEnc] = await Promise.all([seal(ev.title), seal(ev.link), seal(ev.body)]);
    const payload: IngestEvent = {
      kind: ev.kind,
      source_id: ev.sourceId,
      project_id: ev.remoteProjectId,
      tool: ev.tool,
      key_id: kid,
      at: ev.at,
    };
    if (titleEnc != null) payload.title_enc = titleEnc;
    if (ev.link !== undefined) payload.link_enc = linkEnc;
    if (ev.body !== undefined) payload.body_enc = bodyEnc;

    const res = await fetch(rs.baseUrl + '/api/remote/ingest', {
      method: 'POST',
      headers: { ...authHeaders(rs), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('shared space answered ' + res.status + ' on /ingest');
    await recordRemoteOk(env.DB, rs.id, Date.now());
    return { ok: true };
  } catch (err) {
    const message = describe(err);
    try {
      await recordRemoteError(env.DB, rs.id, 'forward failed: ' + message);
    } catch {
      // Never let bookkeeping fail the caller.
    }
    return { ok: false, error: message };
  }
}

export interface RemoteProjectsResult {
  space: RemoteSpaceRow;
  /** Null when the fetch failed (see error). */
  projects: ProjectRow[] | null;
  error?: string;
}

/** Fetches the project list of every remote space in parallel, 3s timeout each. Never throws. */
export async function listRemoteProjects(env: Bindings, spaces: RemoteSpaceRow[]): Promise<RemoteProjectsResult[]> {
  const settled = await Promise.allSettled(
    spaces.map(async (rs): Promise<RemoteProjectsResult> => {
      const res = await fetch(rs.baseUrl + '/api/remote/projects', {
        headers: authHeaders(rs),
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('shared space answered ' + res.status);
      const body = (await res.json()) as Partial<RemoteProjectsResponse>;
      if (!Array.isArray(body.projects)) throw new Error('unexpected response');
      const projects = body.projects.filter(
        (p): p is ProjectRow => typeof p === 'object' && p !== null && typeof p.id === 'string' && typeof p.name === 'string' && !p.archivedAt,
      );
      return { space: rs, projects };
    }),
  );
  const out: RemoteProjectsResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const rs = spaces[i];
    const r = settled[i];
    if (!rs || !r) continue;
    if (r.status === 'fulfilled') {
      out.push(r.value);
      try {
        await recordRemoteOk(env.DB, rs.id, Date.now());
      } catch {
        // ignore
      }
    } else {
      const error = describe(r.reason);
      out.push({ space: rs, projects: null, error });
      try {
        await recordRemoteError(env.DB, rs.id, 'project list failed: ' + error);
      } catch {
        // ignore
      }
    }
  }
  return out;
}
