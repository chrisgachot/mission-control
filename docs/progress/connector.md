# connector track progress

Newest first. Mark uncertainty with ?.

## Status: done, typecheck clean, smoke tested (2026-10-31)

### Files written
- `src/status.ts`: `deriveStatus`, `bucketActivity` (24h = 24 hourly, 7d = 7 daily, 30d = 30 daily; windows end at `now`, no time zone dependence), `rangeStart`, `RANGE_MS`, `isRange`.
- `src/db/`: `rows.ts` (row mappers, constant SQL fragments), `projects.ts`, `workstreams.ts` (incl. updates), `board.ts` (`buildLocalSlice`, shared by `/api/board` and `/api/remote/board`), `tokens.ts` (sha256 base64url, connector + member token lookup, mint/rotate), `spaces.ts` (space_meta, current space key, remote_spaces, `getSpaceInfo`), `encrypt.ts` (`encryptCurrent`, the only caller of `encryptForKey` besides `src/forward.ts`), `util.ts`.
- `src/mcp/{router,server,tools}.ts`: stateless Streamable HTTP, fresh server + transport per request.
- `src/api/{space,board,workstreams,projects,setup,remote}.ts`, plus helpers `src/api/_csrf.ts` (`requireCsrfHeader`) and `src/api/_http.ts` (`apiError`, `readJson`, `waitUntilOf`). `_http.ts` is not in the brief's file list; it is just shared plumbing.
- `src/forward.ts`: `forwardEvent`, `listRemoteProjects`.
- `src/setup-content.ts`: PLACEHOLDER (`connectInstructions` with empty arrays) because the Deploy track had not written it yet. Deploy track overwrites it.

### Behaviour decisions (please review)
- Zod v4 raw shapes typecheck fine with `registerTool` (SDK 1.32.2 zod-compat). No casts needed.
- MCP errors: every tool body runs in `guarded()`; failures (including the crypto stub throwing) come back as `isError: true` with `{error:{code,message}}` text. Verified: HTTP 200, clean JSON-RPC result, not a 500.
- `origin_user_id` is set to the connector token's user on local writes. `external_id` lookup (idempotent `report_started`) and `find_workstreams` are scoped to `origin_user_id IS NULL OR = user`, so seeded rows with null origin stay reachable.
- `report_started` with a matching non-archived `external_id` returns the existing workstream with its real stored status (could be `done`) plus `reused: true`; appends nothing. The spec table says `status:'running'` literally; I return the real status.
- Agent reports: `milestone` -> status running (also reopens a done one, clears `done_at`); `waiting` -> waiting and clears `snoozed_until` so it resurfaces; `done` -> done. Reporting on an archived workstream is a tool error (`archived`) telling the agent to start a new one.
- The `started` update row stores the title ciphertext as its `body_enc`, so `latestUpdate` always has text on a fresh workstream.
- `find_workstreams` returns the stored status plus an extra `stale: boolean`.
- Forwarding: remote projects need a local FK row, so `list_projects` upserts a mirror `projects` row (remote_space_id + remote_project_id, unique index) per shared project and returns the LOCAL mirror id with `space` = remote space name. If a space is unreachable, its last known mirrors are still listed. Agent writes to a mirror project are stored locally (local key) and forwarded in `waitUntil` (not awaited), so a slow shared space never slows the agent. Failures go to `remote_spaces.last_error`.
- A forwarded `milestone/waiting/done` for a workstream the shared space never saw `started` for returns 409 `unknown_workstream` (titles are encrypted, so it cannot be fabricated). Consequence: if the very first `started` forward fails, later events for that workstream also fail to forward. A retry/outbox is not built (?). Events for a workstream archived in the shared space return 200 `{ignored:true}`.
- Ingest stamps the shared space's own clock (`last_agent_at = now`), ignoring `IngestEvent.at`, so a member cannot fake freshness. Ingest validates `key_id` exists in `space_keys` (retired keys accepted) and that each `*_enc` string parses as an envelope with `kid === key_id`.
- `/api/remote/board` returns the whole shared space (all members), `spaceId: null`; the personal copy rewrites `spaceId/spaceName` and sets `remoteSpaceId` on each workstream.
- The personal board's local slice includes workstreams under mirror projects (the local mirror copy), so a shared-project workstream appears both in `local` and in the shared slice. The dashboard should de-duplicate (the local mirror has `projectId` pointing at a project with `remoteSpaceId` set) or hide one side (?).
- Board: running/waiting always; done only if `done_at` is within the range; archived only if archived within 30 days. `updates` = updates in range, newest first, capped at 500; `activity` is computed from all agent updates in range (not from the capped list).
- Workstream detail only covers local workstreams (no remote detail route in the contract).
- Person actions validate the starting status (409 `invalid_state`): handled/snooze/resume from running|waiting, archive from running|waiting|done, reopen from done|archived. Each appends an `action` update (encrypted text "Handled", "Snoozed for a day", "Archived", "Resumed", "Reopened"); the contract only lists updates for handled/snooze/resume, I added archive/reopen for the timeline. `resume`/`reopen` also clear `snoozed_until`.
- Setup: `GET /api/setup` mints a token only when the user has none (single race-safe INSERT ... WHERE NOT EXISTS) and returns the full URL that one time. Otherwise returns `https://<origin>/mcp/••••` (four U+2022 bullets) with `tokenCreatedAt`. `SetupResponse` has no "is masked" flag, so the dashboard should detect the bullets (?). URL origin comes from the request URL (so http on local dev). `POST /api/setup/rotate-token` revokes the user's tokens and mints a new one, returning the full URL.
- Project names: trimmed, 1..60 chars, single line, unique case-insensitively among non-archived (checked in app code, JS lowercase, so non-ASCII works). Mirror projects cannot be renamed. Un-archiving re-checks uniqueness.
- All state-changing session routes (`POST /api/projects`, `PATCH /api/projects/:id`, `POST /api/workstreams/:id/action`, `POST /api/setup/rotate-token`) check `X-Requested-With: mission-control` (403 `csrf`). `/api/remote/*` and `/mcp/*` are bearer-token routes and do not.
- Sessions: I rely on the `requireSession` / `requireRole` stub contract; GET `/api/setup` reads `c.get('user')`.

### Verification
- `npx tsc --noEmit` passed for the whole repo when my files landed. A later re-run shows 4 errors, all in other tracks' files and not mine: `test/health.test.ts` and `test/setup.ts` (`cloudflare:test` and `?raw` module types missing, Support/orchestrator), `web/src/board/views.ts` (`../vault.ts` not written yet, Security). No errors in `src/`.
- Local D1 migration applied; `wrangler dev` smoke test of the real `/mcp/:token` route (real crypto stub): 401 on bad token, 405 + `Allow: POST` on GET, `initialize` returns serverInfo + the instructions text, `tools/list` shows 6 tools with schemas, `list_projects` works, `find_workstreams` works, bad enum input returns a clean validation error, `report_started` fails with a clean `isError` JSON-RPC result (HTTP 200) because `encryptForKey` throws in the stub, as expected.
- Fuller end-to-end run against a COPY of `src/` in `/tmp/mctest` with a fake `encryptForKey` and a test entry that fakes the session via a header (repo files untouched): report_started (incl. idempotent external_id), waiting/milestone/done transitions, find_workstreams, `/api/board` (ranges, bad range 400, no session 401, activity buckets, keyIds), workstream detail, all person actions with invalid-state 409s and CSRF 403, projects CRUD (trim, dupes case-insensitive, length, role 403, archive/unarchive/reorder), setup mask + rotate (old token 401, new token works), `/api/remote/*` with a member token (401, space, projects, ingest started/idempotent/waiting, unknown key 400, bad envelope 400, milestone-without-started 409, board), and a loopback "shared space" (remote_spaces row pointing at itself): mirror upsert in `list_projects`, forward on report_started/report_milestone verified on the receiving side, dead remote host leaves the agent call successful, board slice gets `error`, `last_error` recorded.
- `deriveStatus` and `bucketActivity` checked directly under node (stale at exactly 7d boundary logic, snooze, 24/7/30 bucket counts, boundary event placement).
- Not done: Vitest tests (Support track owns `test/**`); real crypto round trip (Security track's `encryptForKey` was still a stub); real two-Worker forwarding (only loopback).
- Local D1 was cleaned of all test rows after the run (rows deleted, tables and migration intact).

### Open issues / uncertain
- `?` Dashboard double counting of shared-project workstreams (local mirror + shared slice), see above.
- `?` No outbox/retry for failed forwards.
- `?` `src/setup-content.ts` is a placeholder until Deploy overwrites it.
- `?` `requireSession` is a stub that always 401s; real behaviour untested with the real middleware.
- `?` Forwarding uses `waitUntil` (not awaited); if Chris prefers synchronous forwarding with a timeout for stronger ordering guarantees, change `forwardInBackground` in `src/mcp/tools.ts`.
