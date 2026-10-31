# support track progress

Newest first. Mark uncertainty with ?.

## Wave 2: tests

Integration tests under `test/`, run with `npx vitest run`. Result: 8 files, 97 tests, all passing (76 new, 21 existing). `npx tsc --noEmit -p test/tsconfig.json` is clean. Two runs in a row gave the same result. No file outside `test/` was touched (`docs/progress/support.md` is the only exception, as the task asked).

New files and counts:
- `test/helpers.ts`: fixtures. `seedSpace()` (owner, live session, space key from a real P-256 pair, connector token, two projects), `addUser`, `addMemberToken`, `sealFor`/`openField` (envelopes), `apiFetch` (adds the cookie and `X-Requested-With`), `mcpRpc`/`mcpCall`/`callTool` (tools/call unwrapped to `{ isError, data }`), `resetDb()`.
- `test/mcp.test.ts` (18): token 401, revoked 401, GET 405, initialize instructions, the six tools, list_projects, report_started (encrypted title, idempotent external_id, unknown project, empty title), milestone/waiting/done, unknown id as a tool error (HTTP 200), archived id, find_workstreams filters and LIKE escaping.
- `test/board.test.ts` (8): local slice, derived status, latestUpdate, titles decrypt, 7 daily buckets with per-tool counts, 24h/30d lengths, bad range 400, no cookie 401, backdated 8 days gives `stale`, snoozed stays `waiting`.
- `test/actions.test.ts` (15): all five actions against ARCHITECTURE §2 (timestamps, snooze = now + 24h, resume clears snooze and refreshes last_agent_at, reopen from done and archived), 409 on disallowed transitions, 404, 400, missing and wrong `X-Requested-With` 403, timeline with the person's "Handled" update.
- `test/projects.test.ts` (12): list, create (201), trim, duplicate name case-insensitive 409, empty name 400, member 403, missing header 403, archive hides from list_projects and report_started, unarchive restores, PATCH on unknown id 404, empty patch 400.
- `test/setup.test.ts` (7): first GET mints a full URL, second GET masked with the same createdAt, only the hash is stored, rotate returns a new URL, old token 401, new token works, rotate without header 403.
- `test/remote.test.ts` (16): member bearer on /space and /projects, wrong/missing/malformed/revoked/removed-user bearer 401, started then milestone on the same source_id (same workstream, 2 updates), duplicate started idempotent, ingest works without `X-Requested-With` (exempt), unknown key_id 400 `unknown_key`, kid mismatch 400 `bad_envelope`, unknown project 404, milestone with no started 409, /board slice.

Approach and decisions:
- Sessions and tokens are seeded directly into D1. The dev bypass only applies to localhost, and the tests use `mission-control.test`, so no `vitest.config.ts` change was needed.
- Hashes (session id, connector and member token hashes) are computed in `test/helpers.ts` with WebCrypto, not imported from `src`. That way a wrong hashing scheme in `src` fails the tests instead of matching on both sides.
- `resetDb()` deletes rows from every table in `beforeEach`. I did not rely on the plugin's storage isolation. This is test-DB only and deletes no files.
- Remote tests play the personal copy by sealing envelopes to the shared key and calling `/api/remote/*` directly, which is what `src/forward.ts` sends. `forwardEvent` itself, and the MCP-to-shared-space path, are NOT exercised end to end.

Bugs: none found in the paths covered. No `it.fails` or skips were needed.

Not covered (outside the Wave 2 list): `src/api/auth.ts`, `keys.ts`, `invites.ts`, `members.ts`, `remote-spaces.ts`, `src/forward.ts` end to end, the dashboard.

Unsure (`?`):
- Test output prints "Using secrets defined in .dev.vars", but there is no `.dev.vars` in the repo root. I did not check where the plugin reads it. The tests never hit localhost, so the bypass should not apply.
- The `last_used_at` assertion polls for up to 1 s because `touchConnectorToken` runs in `waitUntil`. It is not flaky in two runs, but it is timing-dependent.

## 2026-10-31 (Support worker, session 1)

Done:
- `scripts/seed.mjs` (`npm run seed:local`). Bundles `src/crypto/index.ts` with esbuild into the OS temp dir and imports it. Generates the space key and the user key, a recovery code, and wraps the space key with the recovery secret. Inserts rows through `wrangler d1 execute DB --local --command` (one statement per call, quotes doubled). Creates 23 workstreams through the real connector at `/mcp/devtoken`, then backdates `workstreams` and `updates` timestamps. Refuses to run on a non-local `--base`, and refuses to run again on a seeded database (exit 1, reset instructions printed, nothing deleted). Key generation runs before any server or DB check, so a stub crypto module fails first with a clear message.
- Verified in a scratch copy (`/tmp/mc-e2e`, not the repo, so no `.wrangler` state was left in the repo): migration applied, `wrangler dev` on 127.0.0.1:8787, seed ran to exit 0. Counts: 6 projects, 23 workstreams (6 done, 13 running, 4 waiting), 74 updates. The recovery code unwraps the stored space key and decrypts seed-1's title ("Approve UniFi U7 Pro purchase"). No plaintext titles in `title_enc`. The rerun guard refuses cleanly.
- Backdating SQL checked against the migration in sqlite before use: the newest update sits at now minus hours, earlier updates step back 18 h each.
- `test/setup.ts` applies `migrations/0001_init.sql` in `beforeAll` (split on `;`, `--` comments stripped line by line). The migration is imported with `?raw`.
- `test/env.d.ts` augments `Cloudflare.Env` with `Bindings`, so `env.DB` is typed.
- `test/health.test.ts` (`SELF.fetch('/api/health')`, expects 200 and `ok: true`). Passes. Typecheck of `test/tsconfig.json` passes.
- `test/tsconfig.json` fixed. It extended itself (`./tsconfig.json` from inside `test/`), which broke the transform. Now extends `../tsconfig.json`, includes `./**/*.ts`, and uses `@cloudflare/vitest-plugin/types`.
- `CONTRIBUTING.md` written (setup, file ownership from PLAN.md, rules).

Blocked or not done:
- `docs/REPORTING-RULES.md` was NOT written. The file-write guard rejected it twice with "Subagents should return findings as text, not write report files", most likely because the filename contains REPORT. CONTRIBUTING.md wrote fine. The full text was returned in the final report instead. Someone with write access needs to create it, or the guard needs to allow it.

Needs the orchestrator (outside my ownership):
- `vitest.config.ts` fails to load. It imports `cloudflare` from `@cloudflare/vitest-plugin`, but the plugin exports `cloudflareTest` (see `dist/pool/index.mjs`). So `npm test` cannot run yet. I verified the health test with a verification-only config at `/tmp/mc-vitest/vitest.config.mjs` (same settings, real export name). The one-line fix is `import { cloudflareTest } from '@cloudflare/vitest-plugin'` and `plugins: [cloudflareTest({...})]`.
- `wrangler.jsonc` needed no change for the test run.

Unsure (`?`):
- The seed prints the owner's PKCS8 private key to the console, because the task asked for it as a dev artifact. This conflicts with the "no plaintext in logs" rule in CONTRIBUTING.md. The key is not needed to unlock, and it is printed only, never stored. Consider dropping the print.
- The seed's exit code on a rerun is 1. The task said "stop with a message". Say if you want 0.
- The unlock steps assume `DEV_BYPASS_USER_ID` in `.dev.vars`. It now exists in `src/middleware/session.ts` and `src/env.d.ts`. I did not test the bypass path in a browser.
- The two ChatGPT fixture items are my own invention: "Draft Beacon status email template" (running) and "Choose a label name for Cousy" (waiting, needed text "Pick one of the three label names").
- For done items the last log line is the result and earlier lines are milestones. The mockup lists them as one log, so this split is my choice.
- The spec's "Reporting rules for agents" text is not in the repo. I based the reporting guide on ARCHITECTURE §4 only.
- `SELF` is marked deprecated in the plugin's `cloudflare:test` types (use `exports` from `cloudflare:workers`). I kept `SELF` as the task asked.
- Stripping `--` line comments is safe for this migration, but it would break on a `--` inside a string literal.
- Scratch dirs left outside the repo: `/tmp/mc-e2e` (copy with `wrangler dev` state) and `/tmp/mc-verify`, `/tmp/mc-vitest`.

