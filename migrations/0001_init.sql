-- Mission Control: initial schema.
-- Plaintext columns: ids, tool, status, kind, timestamps, project names.
-- Encrypted columns end in _enc and hold a JSON envelope (see src/crypto): {"v":1,"kid":"...","epk":"...","iv":"...","ct":"..."}

CREATE TABLE IF NOT EXISTS space_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: name, kind ('personal' | 'shared'), created_at, setup_complete ('0'|'1')

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  public_key TEXT,                 -- user's own P-256 public key (raw, base64url) for wrapping shared keys to this user
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,             -- WebAuthn credential id, base64url
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,        -- COSE public key, base64url
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                 -- JSON array
  prf_supported INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'register' | 'login'
  user_id TEXT,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,             -- sha256 of the cookie value, base64url
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Versioned space encryption keys. The newest non-retired key encrypts new data.
CREATE TABLE IF NOT EXISTS space_keys (
  id TEXT PRIMARY KEY,             -- kid
  public_key TEXT NOT NULL,        -- P-256 raw public key, base64url
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

-- A space private key, wrapped for one user by one method.
CREATE TABLE IF NOT EXISTS wrapped_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_id TEXT NOT NULL REFERENCES space_keys(id),
  wrap_kind TEXT NOT NULL CHECK (wrap_kind IN ('prf','recovery','user_pub')),
  credential_id TEXT,              -- for wrap_kind 'prf': which passkey's PRF output wraps it
  wrapped TEXT NOT NULL,           -- JSON (see src/crypto WrappedKey)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wrapped_user ON wrapped_keys(user_id, key_id);

-- Connector (MCP) bearer tokens. The URL is /mcp/<token>; only the hash is stored.
CREATE TABLE IF NOT EXISTS connector_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- Tokens that another space (a member's personal copy) uses to forward updates into this shared space.
CREATE TABLE IF NOT EXISTS member_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- Shared spaces this (personal) copy forwards to and reads from.
CREATE TABLE IF NOT EXISTS remote_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,          -- https://lighthill-mission-control.example.workers.dev (no trailing slash)
  member_token TEXT NOT NULL,      -- plaintext: this Worker must present it
  created_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  last_error TEXT,
  removed_at INTEGER               -- soft delete; rows are never deleted
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,              -- plaintext by decision (agents must read it)
  remote_space_id TEXT REFERENCES remote_spaces(id),   -- set when the project lives in a shared space
  remote_project_id TEXT,          -- the project's id inside that shared space
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_remote ON projects(remote_space_id, remote_project_id);

CREATE TABLE IF NOT EXISTS workstreams (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  tool TEXT NOT NULL CHECK (tool IN ('code','cowork','duet','chat','chatgpt')),
  status TEXT NOT NULL CHECK (status IN ('running','waiting','done','archived')),
  title_enc TEXT NOT NULL,
  link_enc TEXT,                   -- where to jump back in (session URL), encrypted
  external_id TEXT,                -- agent-supplied id (session id, thread id) for resuming, plaintext, optional
  key_id TEXT NOT NULL REFERENCES space_keys(id),
  origin_user_id TEXT REFERENCES users(id),   -- in a shared space: which member's agent reported it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,     -- any change, agent or person
  last_agent_at INTEGER NOT NULL,  -- last agent report; staleness is measured from this
  snoozed_until INTEGER,
  done_at INTEGER,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workstreams_project ON workstreams(project_id);
CREATE INDEX IF NOT EXISTS idx_workstreams_status ON workstreams(status, last_agent_at);
CREATE INDEX IF NOT EXISTS idx_workstreams_external ON workstreams(external_id);

CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id),
  kind TEXT NOT NULL CHECK (kind IN ('started','milestone','waiting','done','action')),
  actor TEXT NOT NULL CHECK (actor IN ('agent','person')),
  body_enc TEXT,                   -- the one line: milestone text, what is needed, the result, or the person's action
  key_id TEXT REFERENCES space_keys(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_updates_ws ON updates(workstream_id, created_at);
CREATE INDEX IF NOT EXISTS idx_updates_time ON updates(created_at);

-- Shared-space invites. wrapped_key is the shared private key wrapped with a key derived from the invite secret,
-- which travels only in the URL fragment. The server never sees the secret.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  key_id TEXT NOT NULL REFERENCES space_keys(id),
  wrapped_key TEXT NOT NULL,       -- JSON WrappedKey, wrap_kind 'invite'
  claim_hash TEXT NOT NULL,        -- sha256(claim), claim = SHA-256("mission-control/invite-claim/v1" || secret); proves the registrant holds the fragment secret
  role TEXT NOT NULL DEFAULT 'member',
  expires_at INTEGER NOT NULL,
  claimed_by TEXT REFERENCES users(id),
  claimed_at INTEGER
);
