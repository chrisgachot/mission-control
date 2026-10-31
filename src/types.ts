/**
 * Shared domain types. Owned by the orchestrator. Every track imports from here;
 * nobody redefines these shapes locally.
 */

export const TOOLS = ['code', 'cowork', 'duet', 'chat', 'chatgpt'] as const;
export type Tool = (typeof TOOLS)[number];

export const TOOL_NAMES: Record<Tool, string> = {
  code: 'Claude Code',
  cowork: 'Cowork',
  duet: 'Duet',
  chat: 'Claude chat',
  chatgpt: 'ChatGPT',
};

/** Stored status. 'stale' is never stored; it is derived (see DerivedStatus). */
export type Status = 'running' | 'waiting' | 'done' | 'archived';

/** What the dashboard shows. 'stale' = running or waiting with no agent report for STALE_AFTER_DAYS. */
export type DerivedStatus = 'running' | 'waiting' | 'stale' | 'done' | 'archived';

export const STALE_AFTER_DAYS = 7;
export const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

export type UpdateKind = 'started' | 'milestone' | 'waiting' | 'done' | 'action';
export type Actor = 'agent' | 'person';

export type PersonAction = 'handled' | 'snooze' | 'archive' | 'resume' | 'reopen';

export type SpaceKind = 'personal' | 'shared';
export type Role = 'owner' | 'admin' | 'member';

/**
 * Encrypted envelope, stored as JSON text in every *_enc column.
 * Produced by src/crypto encryptForKey(); opened only in the browser.
 */
export interface Envelope {
  v: 1;
  kid: string; // space_keys.id used
  epk: string; // ephemeral P-256 public key, raw, base64url (65 bytes)
  iv: string; // 12 bytes, base64url
  ct: string; // AES-256-GCM ciphertext + tag, base64url
}

/** A private key wrapped for one holder. Stored as JSON text in wrapped_keys.wrapped and invites.wrapped_key. */
export interface WrappedKey {
  v: 1;
  kind: 'prf' | 'recovery' | 'user_pub' | 'invite';
  kid: string; // which space key this wraps
  /** prf: PRF salt used (base64url). recovery/invite: HKDF salt. user_pub: ephemeral pubkey (ECIES). */
  salt: string;
  iv: string;
  ct: string; // wrapped PKCS8 private key, base64url
}

// ---------- API shapes (what the Worker returns, before browser-side decryption) ----------

export interface SpaceInfo {
  name: string;
  kind: SpaceKind;
  setupComplete: boolean;
  /** Current (newest, non-retired) space public key, raw P-256, base64url. Null before setup. */
  publicKey: string | null;
  keyId: string | null;
  version: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  remoteSpaceId: string | null;
  remoteProjectId: string | null;
  sortOrder: number;
  createdAt: number;
  archivedAt: number | null;
}

export interface WorkstreamRow {
  id: string;
  projectId: string;
  tool: Tool;
  status: Status;
  /** Derived server-side from status, last_agent_at and snoozed_until. */
  derived: DerivedStatus;
  titleEnc: string; // Envelope JSON
  linkEnc: string | null;
  externalId: string | null;
  keyId: string;
  originUserId: string | null;
  createdAt: number;
  updatedAt: number;
  lastAgentAt: number;
  snoozedUntil: number | null;
  doneAt: number | null;
  archivedAt: number | null;
  /** Most recent update's encrypted body, so the board can show "next step" without a second call. */
  latestUpdate: UpdateRow | null;
  /** When this workstream came from a shared space, which one. Null for local. */
  remoteSpaceId: string | null;
}

export interface UpdateRow {
  id: string;
  workstreamId: string;
  kind: UpdateKind;
  actor: Actor;
  bodyEnc: string | null;
  keyId: string | null;
  createdAt: number;
}

export type Range = '24h' | '7d' | '30d';

/** One time bucket of agent activity (count of agent updates), per tool. */
export interface ActivityBucket {
  start: number; // epoch ms, bucket start
  end: number;
  counts: Record<Tool, number>;
}

export interface BoardSlice {
  spaceId: string | null; // null = this (local) space; else remote_spaces.id
  spaceName: string;
  projects: ProjectRow[];
  workstreams: WorkstreamRow[];
  /** Updates in the selected range, for timelines and "what happened" lists. */
  updates: UpdateRow[];
  activity: ActivityBucket[];
  /** Keys needed to read this slice: kid -> public key (so the browser can match wrapped private keys). */
  keyIds: string[];
  error?: string; // remote fetch failed; slice may be empty
}

export interface BoardResponse {
  now: number;
  range: Range;
  space: SpaceInfo;
  local: BoardSlice;
  remote: BoardSlice[];
}

export interface WorkstreamDetail {
  workstream: WorkstreamRow;
  updates: UpdateRow[];
  project: ProjectRow;
}

export interface SetupResponse {
  connectorUrl: string; // https://<host>/mcp/<token>, or masked when tokenMasked is true
  /** True when the token part is hidden (it is shown only right after minting or rotation). */
  tokenMasked: boolean;
  tokenCreatedAt: number;
  instructions: ConnectInstructions;
}

/** Owned by the Deploy track (src/setup-content.ts). Rendered by the dashboard's setup page. */
export interface ConnectInstructions {
  claude: string[]; // Claude.ai / Cowork / Duet: steps
  claudeCode: string[]; // claude mcp add ...
  chatgpt: string[];
  reportingRules: string; // short paragraph agents should know
}

// ---------- MCP tool contracts (what agents call) ----------

export interface ReportStartedInput {
  title: string; // short, imperative, <= 80 chars
  project_id: string; // from list_projects
  tool: Tool;
  link?: string; // URL back into the session, if the tool has one
  external_id?: string; // session/thread id so a later session can resume the same workstream
}

export interface ReportUpdateInput {
  workstream_id: string;
  note: string; // one line
}

/** Ingest from a member's personal copy into a shared space. Already encrypted with the shared space's key. */
export interface IngestEvent {
  kind: 'started' | 'milestone' | 'waiting' | 'done';
  /** The personal copy's workstream id; the shared space keys by (member, source_id) via external_id. */
  source_id: string;
  project_id: string; // shared space's project id
  tool: Tool;
  title_enc?: string; // required for 'started'
  link_enc?: string | null;
  body_enc?: string | null;
  key_id: string; // shared space kid used
  at: number;
}

export interface RemoteProjectsResponse {
  space: SpaceInfo;
  projects: ProjectRow[];
}
