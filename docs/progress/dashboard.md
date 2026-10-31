# dashboard track progress

Newest first. Mark uncertainty with ?.

## 2026-10-31 first full pass

### What was built
- `web/mockup.html`: the reference mockup, verbatim from the artifact.
- `public/index.html` (shell: fonts, `#app`, `/app.js`) and `public/styles.css` (mockup CSS moved out unchanged, plus an "additions" block for setup, unlock, first run, invite, connect, shared tag, notes, focus-visible).
- `web/src/`
  - `app.ts` router and lifecycle. `/` board, `/setup`, `/invite/:id`, `/connect`. `GET /api/space` then: not `setupComplete` -> first run; `vault.state()==='locked'` -> unlock; no session (`/api/auth/me` 401) -> lock and unlock; else the page. In-app links: `<a data-nav>`. `?fixture=1` on `/` renders sample data with no server or vault.
  - `api.ts` typed fetch client (`credentials:'same-origin'`, `X-Requested-With: mission-control`, `ApiError{status,code,message}`).
  - `model.ts` pure: DecryptedBoard -> items, projects, activity buckets, per-project 30-day pulse. `store.ts`, `tools.ts` (5 tools, colors, glyphs, status UI), `util.ts`, `host.ts`, `pages.ts`.
  - `board/`: `page.ts` (shell, load, 30 s poll while visible, sync button, range, lock), `hud.ts` (greeting, readouts, legends), `reactor.ts`, `needs.ts`, `activity.ts`, `projects.ts`, `decay.ts`, `sheet.ts` (back stack, Escape, focus trap and restore), `views.ts` (item / project / tool / list / activity-bucket views, actions), `tooltip.ts`, `toast.ts`, `ui.ts`.
  - `setup.ts`, `onboarding.ts` (first run), `unlock.ts`, `invite.ts`, `connect.ts`.
  - `fixture.ts` (dev only): the mockup's 21 items, 6 projects, 5 tools, plus one ChatGPT item, plus a small shared space "Light Hill" so the shared tag is visible. Counts go through the Worker's own `bucketActivity`.
  - `vault-types.ts`: TEMPORARY local `DecryptedBoard`, `DecryptedSlice`, `DecryptedWorkstream`, `DecryptedUpdate`, `ConnectPayload`. Orchestrator should replace these imports with the types from `vault.ts`.

### Behaviour decisions
- Status mapping: derived `waiting` -> UI "needs" (unless `snoozedUntil > now`, then it shows as running with a "snoozed" note); `stale`, `running`, `done` as is; `archived` rows and rows of archived projects are hidden.
- Ages: `now - lastAgentAt` (done items: `doneAt`). "Done this week" = done and finished within 7 days. Stale line on the strip plot is `STALE_AFTER_DAYS`.
- Shared items: remote slices blend into every list and chart; they carry a "shared · <space>" tag. They are read-only (no action buttons, no quick pill) because the personal copy has no route to action a shared workstream; the sheet says to handle it in the shared space.
- De-duplication: a personal copy stores a local mirror of work on shared projects and also forwards it. A remote workstream whose `externalId` equals a local workstream id is dropped (the local, actionable row wins), and a remote project that a local mirror project points at (`remoteSpaceId`+`remoteProjectId`) is merged into the mirror. Activity counts for remote slices are recomputed from their `updates` minus those duplicates so forwarded copies are not counted twice. `?` Relies on `externalId == source_id` as ARCHITECTURE section 5 says.
- Sparklines (14 days) and the project sheet's 30-day line come from agent `updates`, never random. The chart range only returns that range's updates, so when the range is 24h or 7d the page also fetches `/api/board?range=30d` (cached 2 minutes, not decrypted: only ids and timestamps are used) for the pulse. Pulse is not filtered by the tool chip.
- Activity bucket labels use the viewer's local time on the server's now-aligned windows. "What happened" lists the agent updates in the window (decrypted `body`), capped at 60.
- Item sheet: shows the board's updates at once, then fetches `GET /api/workstreams/:id` and decrypts each body with `vault.decrypt` for the full timeline (local items only). Actions sit above the timeline; the timeline shows 8 and expands.
- "Open in <tool>" opens `link` only if it is `http(s)`; otherwise toast "No link was reported for this one".
- Quick pill on Needs you is two-step (Approve/Decide/Review/Reply -> Confirm -> `handled`), reverts after 4 s.
- All user text goes through `esc()` before `innerHTML`; sheet title uses `textContent`. Verified with a title containing `<img onerror>`: no element, no script run.
- Reactor ring pitch is 31 (the mockup's 36 does not fit five tools); viewBox widened for labels.
- ChatGPT: color `#19c79a` (mint, kept apart from Claude Code cyan and Duet lime), hexagon-and-dot glyph.

### Verified
- `npx tsc --noEmit`: the only errors in `web/` are `Cannot find module './vault.ts'` (8 files), because the Security track's `vault.ts` does not exist yet. `test/` has pre-existing `cloudflare:test` errors, not mine. With a stub vault at `/tmp/vstub/vault.ts` (rootDirs overlay via `tsconfig.vstub.tmp.json`) typecheck is fully clean.
- `node scripts/build-web.mjs` fails ONLY on the missing `./vault.ts`. With the stub aliased in by an esbuild plugin (`/tmp/vstub/devbuild.mjs`) it bundles to ~101 kB. `public/app.js` currently on disk was built with the STUB vault: rebuild once the real `vault.ts` lands.
- Playwright (Chromium, 1400x1000), static server with SPA fallback:
  - `docs/screens/board.png`, `docs/screens/sheet.png` (from `/?fixture=1`).
  - Also exercised the real-data path (mocked `/api/*`, stub vault): board render, de-dup of a mirrored shared item, XSS title, reactor arc -> sheet -> project -> Back -> Escape, quick action two-step posting `POST /api/workstreams/w1/action` with the CSRF header on every request, 24h range, bucket click sheet, tool filter, setup page (personal and shared), unlock, first run + recovery checkbox gating Continue, invite and connect pages. Extra screenshots: `board-filtered`, `activity-hover`, `setup`, `setup-shared`, `unlock`, `firstrun`, `recovery`, `invite`, `connect` in `docs/screens/`.

### Vault API depended on (import { vault } from './vault.ts')
`state()`, `setup(handle)->{recoveryCode}`, `unlock()`, `unlockWithRecoveryCode(code)`, `lock()`, `decrypt(envJson|null)`, `decryptBoard(BoardResponse)->DecryptedBoard`, `importRemoteKey(ConnectPayload)`, `createInvite(role)->url`, `claimInvite(id, secretB64u, handle)->ConnectPayload`, `rotateAfterRemoval()`. `NeedsRecoveryCode` is detected by `error.name === 'NeedsRecoveryCode'` (or constructor name), so there is no value import of it.

### Uncertain / for the orchestrator
1. `DecryptedBoard` shape: I assume `title`, `link`, `latestUpdate.body`, `updates[].body` replace `titleEnc`, `linkEnc`, `bodyEnc` and every other field is unchanged (see `vault-types.ts`).
2. `/connect`: I call `vault.importRemoteKey(payload)` and then `api.addRemoteSpace({name, baseUrl, memberToken})` (`POST /api/remote-spaces`). If `importRemoteKey` already creates the remote-space row, drop my call (a 409 is tolerated). Same helper is used for "paste a connect link" on the setup page.
3. `claimInvite` returns only `ConnectPayload`, but the member also needs to see their own recovery code. I show `payload.recoveryCode` if the vault adds one (stripped before building the connect link). The Security track should expose it somehow.
4. Connect-link host: the invite page asks the new member to type their personal copy's URL and builds `<their url>/connect#<b64u(JSON payload)>` itself (`b64u` from `src/crypto`).
5. Response shapes I assumed for Security-track routes (still stubs): `GET /api/auth/me -> {user:{id?,handle,role?}}` (401 when no session), `GET /api/members -> {members:[{id,handle,role}]}` or an array, `GET /api/remote-spaces -> {remoteSpaces:[{id,name,baseUrl,lastError?}]}` or array, `POST /api/remote-spaces {name, baseUrl, memberToken}`, `GET /api/invites/:id -> {valid, spaceName, role}`.
6. Setup page treats a `connectorUrl` containing a bullet (U+2022), `*` or ellipsis as masked (the Connector track's `••••`): Copy is disabled and Rotate is offered. The unmasked URL is held in memory only.
7. Shared items cannot be actioned from the personal board (no proxy route). If wanted, add a Worker route that forwards actions with the member token.
8. Fonts load from Google Fonts as in the mockup; the CSS falls back to SF/system fonts.
9. Scratch file I could not delete (rule: never delete files): `/home/user/mission-control/tsconfig.vstub.tmp.json` (typecheck with a stub vault). Safe to remove. Other scratch lives in `/tmp/vstub/`.
