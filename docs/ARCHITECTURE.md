# Architecture and interface contract

This is the contract every track builds against. Change it only through the orchestrator. Types referenced here live in `src/types.ts`; bindings in `src/env.d.ts`; schema in `migrations/0001_init.sql`.

## 1. One Worker, three faces

```
agents ──POST /mcp/<token>──▶ ┌────────────────────────────┐
                              │  Cloudflare Worker (Hono)   │──▶ D1 (DB)
browser ──GET /api/*────────▶ │  src/index.ts               │
browser ──GET /* (assets)───▶ │  ASSETS (public/)           │──▶ other spaces (forwarding, fetch)
                              └────────────────────────────┘
```

- `src/index.ts` (orchestrator) creates the Hono app, mounts routers, adds `requestId`, error handling, and falls through to `ASSETS` for anything else.
- Every router is a `Hono<AppEnv>` exported as `router` from a fixed path (see §7). Routers never create their own Hono type; they import `AppEnv` from `../env.d.ts`.
- Validation uses `zod` (v4). Return JSON errors as `{ error: { code: string, message: string } }` with a proper status. Never leak stack traces.
- Time is epoch milliseconds everywhere (`Date.now()`). Ids are `crypto.randomUUID()`.
- D1 access goes through `src/db/*` query functions (Connector track). Other tracks call those functions rather than writing SQL, except the Security track, which owns SQL for users, credentials, challenges, sessions, space_keys, wrapped_keys, member_tokens, invites, remote_spaces (auth-adjacent tables) in `src/auth/db.ts`.

## 2. Data model (see migration for columns)

- A **space** is one deployment. `space_meta` holds name, kind (`personal` | `shared`), `setup_complete`.
- **users**: one `owner` on a personal copy. On a shared copy: the creator is `admin`; invitees are `member`.
- **space_keys**: versioned P-256 keypairs. Newest non-retired key encrypts new data. Old keys stay so history remains readable.
- **wrapped_keys**: a space private key wrapped for a user by one method (`prf`, `recovery`, `user_pub`).
- **projects**: plaintext name. Local, or a mirror of a project in a `remote_spaces` row (shared space).
- **workstreams**: one lane of agent work. Stored `status` ∈ running | waiting | done | archived. `stale` is derived.
- **updates**: the timeline. `kind` ∈ started | milestone | waiting | done | action (person acted). `body_enc` is the one line.

### Status derivation (Connector track, `src/status.ts`)

```ts
export function deriveStatus(ws: {status: Status; lastAgentAt: number; snoozedUntil: number|null}, now: number): DerivedStatus
```
- `done` → `done`; `archived` → `archived`.
- `running` or `waiting`: if `now - lastAgentAt >= STALE_AFTER_MS` and `(snoozedUntil == null || snoozedUntil <= now)` → `stale`; else the stored status.
- Snooze hides a `waiting`/`stale` item from "needs you"/"going cold" until `snoozedUntil`; the board still lists it.

### Person actions (`POST /api/workstreams/:id/action`)

| action | effect |
| --- | --- |
| handled | waiting → running; `updated_at = now`; append update `{kind:'action', actor:'person', body:'Handled'}` |
| snooze | `snoozed_until = now + 24h`; append action update |
| archive | status → archived, `archived_at = now` |
| resume | status → running, `last_agent_at = now` (so it leaves "going cold"), append action update |
| reopen | done/archived → running, clears `done_at`/`archived_at`, `last_agent_at = now` |

Person-action bodies are encrypted like everything else (the Worker encrypts with the current key).

## 3. Encryption (Security track, `src/crypto/`)

Isomorphic WebCrypto only (`globalThis.crypto.subtle`). No Node APIs. The same module is bundled into the browser.

**Space key**: P-256 (ECDH). Public key stored raw (65 bytes, base64url). Private key handled as PKCS8 when wrapped.

**Envelope (encrypt for a public key)**: ECIES.
1. Ephemeral P-256 keypair `e`.
2. `shared = ECDH(e.priv, spacePub)`; `aesKey = HKDF-SHA256(shared, salt = empty, info = "mission-control/v1/" + kid, 256 bits)`.
3. `ct = AES-256-GCM(aesKey, iv = 12 random bytes, plaintext utf8, additionalData = utf8(kid))`.
4. Envelope `{v:1, kid, epk, iv, ct}` serialized as JSON text.

```ts
// src/crypto/index.ts  (public surface; keep these exact signatures)
export function b64u(bytes: ArrayBuffer | Uint8Array): string
export function unb64u(s: string): Uint8Array
export async function generateSpaceKeyPair(): Promise<{ publicKeyRaw: string; privateKeyPkcs8: string }>
export async function encryptForKey(kid: string, publicKeyRaw: string, plaintext: string): Promise<Envelope>
export async function decryptEnvelope(env: Envelope, privateKeyPkcs8: string): Promise<string>
export async function wrapWithSecret(kind: 'recovery' | 'invite' | 'prf', kid: string, privateKeyPkcs8: string, secret: Uint8Array): Promise<WrappedKey>   // HKDF(secret, salt) -> AES-GCM
export async function unwrapWithSecret(w: WrappedKey, secret: Uint8Array): Promise<string>
export async function wrapForUserPub(kid: string, privateKeyPkcs8: string, userPublicKeyRaw: string): Promise<WrappedKey>   // ECIES to a user's own P-256 key
export async function unwrapWithUserPriv(w: WrappedKey, userPrivateKeyPkcs8: string): Promise<string>
export function generateRecoveryCode(): string            // e.g. 8 groups of 4 from a 32-char alphabet, ~160 bits; shown once
export function recoveryCodeToSecret(code: string): Uint8Array
```

**Worker side** uses only `encryptForKey` with the current space key (from `space_keys`). The Worker never holds a private key. Known limit, as the spec says: plaintext passes through Worker memory on arrival.

**User key**: each user also has their own P-256 keypair (`users.public_key`), generated in the browser at setup, private half wrapped exactly like a space key. It exists so an admin can re-wrap a rotated shared key to a member (`wrapForUserPub`) without the member present.

### Passkeys and unlock (Security track, `src/auth/`, `web/src/vault.ts`)

Server: `@simplewebauthn/server` v14 (WebCrypto, works on Workers). Relying party id = request hostname. Challenges stored in `challenges` with 5-minute expiry.

**First run (owner setup)** on a personal copy, or admin on a shared copy, allowed only while `users` is empty:
1. `POST /api/auth/register/options` → PublicKeyCredentialCreationOptions with `extensions.prf = {}` requested.
2. Browser `navigator.credentials.create()`; `POST /api/auth/register/verify` → creates user, credential, session cookie. Response says whether PRF is available (`prfEnabled`).
3. Browser generates the space keypair and the user keypair.
4. If PRF: browser calls `navigator.credentials.get()` with `prf.eval.first = salt` to obtain 32 bytes; wraps both private keys (`wrapWithSecret('prf', …)`).
5. Always: generate a recovery code, wrap both private keys with it, show the code once with a "I saved it" confirmation.
6. `POST /api/keys/setup` `{ spacePublicKey, userPublicKey, wrapped: WrappedKey[] }` → inserts `space_keys` (kid = uuid), `users.public_key`, `wrapped_keys`; sets `space_meta.setup_complete = '1'`.

**Unlock** (every visit): `POST /api/auth/login/options` → `navigator.credentials.get()` with PRF eval → `POST /api/auth/login/verify` → session cookie + `wrapped: WrappedKey[]` for this user. Browser unwraps with the PRF output (or asks for the recovery code if `prf` wraps are absent) and keeps private keys in memory only (never localStorage). Lock = drop them.

**Session**: cookie `mc_session`, HttpOnly, Secure, SameSite=Lax, 30 days; `sessions.id` = sha256(cookie value). Middleware `src/middleware/session.ts`:

```ts
export const loadSession: MiddlewareHandler<AppEnv>   // sets c.set('user', ... | null)
export const requireSession: MiddlewareHandler<AppEnv> // 401 if null
export const requireRole: (roles: Role[]) => MiddlewareHandler<AppEnv>
```

CSRF: all state-changing `/api/*` requests must carry header `X-Requested-With: mission-control`; the middleware rejects otherwise. Cookies are SameSite=Lax so cross-site POSTs lack the cookie anyway.

### Shared space membership

- **Invite** (admin, in the shared space's dashboard): browser makes `secret = random 32 bytes`, `wrapped = wrapWithSecret('invite', kid, sharedPriv, secret)`, `POST /api/invites {wrapped, role}` → `{id}`; link = `https://<shared>/invite/<id>#<b64u(secret)>`. Expires in 7 days.
- **Claim**: invitee opens link → `GET /api/invites/:id` (public: `{valid, spaceName, role}`) → registers a passkey (`/api/auth/register/*` with `inviteId`) → `GET /api/invites/:id/key` (session required, claimed_by must match) → browser unwraps with the fragment secret, re-wraps with PRF and recovery, `POST /api/keys/import {wrapped: WrappedKey[], userPublicKey}`. The shared space also mints a `member_tokens` row and returns the plaintext token once, with a "connect to your personal Mission Control" link: `https://<personal>/connect#<b64u(JSON {name, baseUrl, memberToken, sharedWrapped})>` so the member's personal copy can store the remote space and the member's personal dashboard can also hold the shared private key (re-wrapped with the member's own PRF/recovery on the personal copy).
- **Remove** (admin): `DELETE /api/members/:id` revokes the member's sessions, member tokens and wrapped keys, then the admin's browser performs **rotation**: generate new space keypair, `wrapForUserPub` for every remaining member's `users.public_key`, plus own PRF/recovery wraps, `POST /api/keys/rotate {publicKey, wrapped: WrappedKey[]}` → inserts new key, retires old. New updates use the new kid. Old history stays readable to remaining members (they keep old wrapped keys).

## 4. Connector: MCP server (Connector track, `src/mcp/`)

Transport: `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, **stateless** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`). A fresh `McpServer` + transport per request. Route: `ALL /mcp/:token`. Token lookup: sha256(token) in `connector_tokens` where `revoked_at IS NULL`; update `last_used_at`. Unknown token → 401 JSON.

Server name `mission-control`, version from `APP_VERSION`. `instructions` field in `initialize` result carries the reporting rules (short):

> Report only when state changes, never every step. Call `list_projects` first and pick an existing project; you cannot create projects. `report_started` when you begin a piece of work, `report_milestone` for one-line progress such as "tests passing", `report_waiting` when you need the person (say exactly what: "approve $214", "pick a timeout"), `report_done` with a one-line result. Keep titles short and imperative. If you were given a workstream id or external id earlier, reuse it instead of starting a new one.

Tools (zod schemas; `inputSchema` descriptions matter because agents read them):

| tool | input | returns (text content, JSON) |
| --- | --- | --- |
| `list_projects` | `{}` | `{ projects: [{id, name, space}], rules: string }` (local projects + remote shared projects fetched via §5, non-archived) |
| `report_started` | `ReportStartedInput` | `{ workstream_id, title, project, status:'running' }`. If `external_id` matches an existing non-archived workstream, returns that one (idempotent) and appends no update. |
| `report_milestone` | `{workstream_id, note}` | `{ ok:true, status }` |
| `report_waiting` | `{workstream_id, needed}` | `{ ok:true, status:'waiting' }` sets status waiting |
| `report_done` | `{workstream_id, result}` | `{ ok:true, status:'done' }` sets status done, `done_at` |
| `find_workstreams` | `{ query?: string, external_id?: string, project_id?: string, status?: Status }` | `{ workstreams: [{id, project, tool, status, created_at, last_agent_at, external_id}] }` titles are encrypted so the server matches only on external_id/project/status; `query` is matched against `external_id` and project name |

Every agent-facing write: encrypt `title`, `link`, `note/needed/result` with the current space key (`encryptForKey`), set `last_agent_at = updated_at = now`, insert the `updates` row with `actor:'agent'`.

If the workstream's project is remote (has `remote_space_id`), the write is **also forwarded** (§5) and still stored locally as a mirror (so the person's own board shows it even if the shared space is down). The local mirror is encrypted with the local key; the forwarded copy with the shared key.

Also expose `GET /mcp/:token` → 405 with a JSON hint (stateless, no SSE stream), and `DELETE` → 405.

## 5. Forwarding and reading shared spaces (Connector track, `src/forward.ts`, `src/api/remote.ts`, `src/api/ingest.ts`)

Personal copy → shared copy, bearer = `remote_spaces.member_token`.

| On the shared copy | Auth | Purpose |
| --- | --- | --- |
| `GET /api/remote/space` | member token | `SpaceInfo` (public key + kid, name) |
| `GET /api/remote/projects` | member token | `RemoteProjectsResponse` |
| `POST /api/remote/ingest` | member token | body `IngestEvent`; upserts the workstream keyed by (`origin_user_id`, `external_id = source_id`) and appends the update. 200 `{workstream_id}` |
| `GET /api/remote/board?range=` | member token | `BoardSlice` for that shared space (ciphertext; the member decrypts with the shared key) |

Personal copy flow on an agent write for a remote project: fetch `/api/remote/space` (cache the public key in memory for the request), `encryptForKey(remoteKid, remotePub, plaintext)`, POST `/api/remote/ingest`. Failures are recorded in `remote_spaces.last_error` and never fail the agent's call.

`GET /api/board` on the personal copy fetches each remote space's `/api/remote/board` in parallel (`Promise.allSettled`, 4 s timeout each) and returns them as `remote: BoardSlice[]`. Projects list in `list_projects` merges remote projects (prefixed in `space`).

## 6. Dashboard (Dashboard track, `web/src/`, `public/`)

Port of `web/mockup.html` (the reference) to real data. Same look: dark only, cyberpunk-on-HIG, glass panels, reactor ring chart (rings = tools, sectors = projects), needs-you list, activity line chart, project sparklines, going-cold strip plot, detail sheet with back stack, toast. Every number, arc, dot and row opens what is behind it.

Data flow: `GET /api/space` → if `!setupComplete` show setup; else if no session show unlock; else `GET /api/board?range=` → `vault.decryptBoard(board)` → render. Poll `/api/board` every 30 s while the tab is visible (no Durable Objects in v1).

`web/src/vault.ts` (Security track) exposes:

```ts
export interface Vault {
  state(): 'locked' | 'unlocked' | 'needs-setup';
  setup(handle: string): Promise<{ recoveryCode: string }>;        // full first-run flow, ends unlocked
  unlock(): Promise<void>;                                           // passkey; throws NeedsRecoveryCode if no PRF wrap
  unlockWithRecoveryCode(code: string): Promise<void>;
  lock(): void;
  decrypt(envJson: string | null): Promise<string | null>;          // picks the private key by kid; null in → null out
  decryptBoard(b: BoardResponse): Promise<DecryptedBoard>;          // titles, links, update bodies decrypted; unknown kid → '🔒 (key not available)'
  importRemoteKey(payload: ConnectPayload): Promise<void>;          // from /connect#...
  createInvite(role: Role): Promise<string>;                         // returns the full invite URL (shared copy)
  claimInvite(id: string, secretB64u: string, handle: string): Promise<ConnectPayload>;
  rotateAfterRemoval(): Promise<void>;
}
export const vault: Vault;
```

`DecryptedBoard` mirrors `BoardResponse` with `title`, `link`, and `latestUpdate.body` / `updates[].body` as plaintext strings. Dashboard code treats the vault as the only source of plaintext and never persists it.

Browser API client (`web/src/api.ts`, Dashboard track): `fetch` with `credentials:'same-origin'` and header `X-Requested-With: mission-control` on all requests.

Pages (single `public/index.html`, routed in JS by `location.pathname`): `/` board, `/setup` (connector link + instructions from `GET /api/setup`, plus projects CRUD, remote spaces, members/invites when `kind === 'shared'`), `/invite/:id` claim flow, `/connect` import flow.

## 7. HTTP route table and ownership

| Route | Auth | Owner | File |
| --- | --- | --- | --- |
| `GET /api/health` | none | Orchestrator | `src/index.ts` |
| `GET /api/space` | none | Connector | `src/api/space.ts` |
| `ALL /mcp/:token` | token | Connector | `src/mcp/router.ts` |
| `GET /api/board` | session | Connector | `src/api/board.ts` |
| `GET /api/workstreams/:id`, `POST /api/workstreams/:id/action` | session | Connector | `src/api/workstreams.ts` |
| `GET/POST /api/projects`, `PATCH /api/projects/:id` | session (POST/PATCH: owner/admin) | Connector | `src/api/projects.ts` |
| `GET /api/setup`, `POST /api/setup/rotate-token` | session (owner/admin/member: each user has their own token) | Connector | `src/api/setup.ts` |
| `GET /api/remote/space`, `GET /api/remote/projects`, `POST /api/remote/ingest`, `GET /api/remote/board` | member token | Connector | `src/api/remote.ts` |
| `POST /api/auth/register/options`, `.../register/verify`, `.../login/options`, `.../login/verify`, `POST /api/auth/logout`, `GET /api/auth/me` | none / session | Security | `src/api/auth.ts` |
| `POST /api/keys/setup`, `POST /api/keys/import`, `POST /api/keys/rotate`, `GET /api/keys` | session | Security | `src/api/keys.ts` |
| `POST /api/invites`, `GET /api/invites/:id`, `GET /api/invites/:id/key`, `POST /api/invites/:id/claim` | admin / none / session | Security | `src/api/invites.ts` |
| `GET /api/members`, `DELETE /api/members/:id` | admin | Security | `src/api/members.ts` |
| `GET/POST /api/remote-spaces`, `DELETE /api/remote-spaces/:id` | owner | Security | `src/api/remote-spaces.ts` |
| `/*` | none | Orchestrator → ASSETS | `src/index.ts` |

Each file exports `export const router = new Hono<AppEnv>()` with routes **relative** to its mount point as listed in `src/index.ts`.

## 8. Deploy and updates (Deploy track)

- README has a **Deploy to Cloudflare** button: `https://deploy.workers.cloudflare.com/?url=<repo url>`. The button forks the repo into the person's GitHub, creates the Worker and the D1 database declared in `wrangler.jsonc`, and connects Workers Builds so pushes to the fork redeploy.
- Build command in Workers Builds: `npm run build` ; deploy command: `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy` (migrations run during the rebuild, as the spec asks).
- `.github/workflows/sync-release.yml` in the fork: daily, fetch upstream tags, pick the highest `v*` tag, fast-forward `main` to it, push. That triggers Workers Builds.
- `.github/workflows/health-check.yml`: after a deploy (on push to main, with a delay/poll), call `/api/health`; on failure, run `wrangler rollback` using `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` repository secrets. Document the secrets; if absent the workflow only reports.
- `GET /api/health` returns `{ ok, version, db: 'ok' | 'error', setupComplete }`.

## 9. Conventions

- TypeScript strict. No `any` in exported signatures. `verbatimModuleSyntax`: use `import type`.
- No deletes of files or rows except where this document says (sessions on logout/removal, challenges on use/expiry). Archive instead.
- Logging: `console.log(JSON.stringify({ requestId, event, ... }))`, never plaintext titles or notes.
- Tests: Vitest with `@cloudflare/vitest-plugin`; integration tests hit the Worker via `SELF.fetch`. Unit tests for crypto run in the Workers runtime too.
- Each track appends to `docs/PROGRESS.md` under its own heading with what it did and what it is unsure of. Nobody runs git.
