/** Typed fetch client for the Worker's browser API (docs/ARCHITECTURE.md section 7). */
import type {
  BoardResponse,
  PersonAction,
  ProjectRow,
  Range,
  Role,
  SetupResponse,
  SpaceInfo,
  WorkstreamDetail,
} from '../../src/types.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'mission-control', Accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_' + res.status, err?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

const get = <T>(p: string) => request<T>('GET', p);
const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {});
const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
const del = <T>(p: string) => request<T>('DELETE', p);

export interface Me {
  id?: string;
  handle: string;
  role?: Role;
}
export interface Member {
  id: string;
  handle: string;
  role: Role;
  createdAt?: number;
}
export interface RemoteSpaceInfo {
  id: string;
  name: string;
  baseUrl: string;
  lastError?: string | null;
  lastOkAt?: number | null;
}
export interface InvitePreview {
  valid: boolean;
  spaceName?: string;
  role?: Role;
}

export const api = {
  space: () => get<SpaceInfo>('/api/space'),
  me: async (): Promise<Me | null> => {
    try {
      return (await get<{ user: Me | null }>('/api/auth/me')).user;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  logout: () => post<unknown>('/api/auth/logout'),

  board: (range: Range) => get<BoardResponse>('/api/board?range=' + encodeURIComponent(range)),
  workstream: (id: string) => get<WorkstreamDetail>('/api/workstreams/' + encodeURIComponent(id)),
  action: (id: string, action: PersonAction) =>
    post<WorkstreamDetail>('/api/workstreams/' + encodeURIComponent(id) + '/action', { action }),

  projects: async (): Promise<ProjectRow[]> => (await get<{ projects: ProjectRow[] }>('/api/projects')).projects,
  createProject: async (name: string): Promise<ProjectRow> => (await post<{ project: ProjectRow }>('/api/projects', { name })).project,
  renameProject: async (id: string, name: string): Promise<ProjectRow> =>
    (await patch<{ project: ProjectRow }>('/api/projects/' + encodeURIComponent(id), { name })).project,
  archiveProject: async (id: string, archived = true): Promise<ProjectRow> =>
    (await patch<{ project: ProjectRow }>('/api/projects/' + encodeURIComponent(id), { archived })).project,

  setup: () => get<SetupResponse>('/api/setup'),
  rotateToken: () => post<SetupResponse>('/api/setup/rotate-token'),

  invitePreview: (id: string) => get<InvitePreview>('/api/invites/' + encodeURIComponent(id)),
  members: async (): Promise<Member[]> => {
    const r = await get<{ members: Member[] } | Member[]>('/api/members');
    return Array.isArray(r) ? r : r.members;
  },
  removeMember: (id: string) => del<unknown>('/api/members/' + encodeURIComponent(id)),

  remoteSpaces: async (): Promise<RemoteSpaceInfo[]> => {
    const r = await get<{ remoteSpaces?: RemoteSpaceInfo[]; spaces?: RemoteSpaceInfo[] } | RemoteSpaceInfo[]>('/api/remote-spaces');
    return Array.isArray(r) ? r : (r.remoteSpaces ?? r.spaces ?? []);
  },
  addRemoteSpace: (input: { name: string; baseUrl: string; memberToken: string }) => post<unknown>('/api/remote-spaces', input),
  removeRemoteSpace: (id: string) => del<unknown>('/api/remote-spaces/' + encodeURIComponent(id)),
};
