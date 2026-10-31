# Progress log

Newest first. One line per event. Uncertainty is marked `?`. Each track's own notes live in `docs/progress/<track>.md`.

| When (UTC) | What |
| --- | --- |
| 2026-10-31 21:40 | Security fixes from the review applied and verified in the browser on a fresh shared-space database: invite id alone is refused (page, options 403, verify), full link registers a member with recovery code and connect link, link is single-use. Also: removed admins' invites expire, remote fetches refuse redirects and cap bodies, ingest rejects retired keys, registration checks the current key in SQL. 97 tests pass. |
| 2026-10-31 21:20 | Independent security review (Opus) delivered: `docs/review/security-review-1.md`. One high (invite id alone could join), three medium, several low. Crypto, PRF handling, sessions, CSRF, rotation guards found correct. |
| 2026-10-31 21:05 | Browser end-to-end on a fresh database: first-run passkey registration with PRF (Chromium virtual authenticator), recovery code shown, PRF-wrapped keys stored, reload then passkey unlock succeeds, device without the passkey fails cleanly to the recovery path. Screens in `docs/screens/e2e-*.png`. |
| 2026-10-31 20:55 | Browser end-to-end on the seeded database: recovery-code unlock, real decrypted titles on the board, "mark handled" moves counts, in-app Setup page, Lock. |
| 2026-10-31 20:50 | Seed script run against wrangler dev through the real connector: 6 projects, 23 workstreams, 74 updates; titles stored as ciphertext. |
| 2026-10-31 20:47 | Integration commit. Reconciled vault types, added `tokenMasked` to `SetupResponse`, made remote-space removal a soft delete (`removed_at`), fixed vitest plugin import. `tsc` clean, bundle 147 kB, 21 tests pass. Launched independent security review (Opus) and integration-test pass (Haiku). |
| 2026-10-31 20:45 | All five tracks reported. Dashboard screenshots reviewed against the mockup. |
| 2026-10-31 20:25 | Scaffold committed. Five tracks launched in parallel: Connector (Sonnet), Security (Opus), Dashboard (Sonnet), Deploy (Sonnet), Support (Haiku). |
| 2026-10-31 20:15 | Orchestrator read the spec and the mockup, wrote PLAN.md and ARCHITECTURE.md, scaffolded the repo, pinned dependencies (vitest 4 + @cloudflare/vitest-plugin, MCP SDK 1.32 web-standard transport). |
| 2026-10-31 20:05 | Session started. No GitHub repository attached; building locally in `/home/user/mission-control`. `?` Chris to create the repo. |

## Verified

- `npm run typecheck`, `npm test` pass.
- MCP over `/mcp/<token>`: initialize, tools/list (6 tools), list_projects, report_* with idempotent `external_id`, tool errors come back as JSON-RPC `isError`, bad token 401, GET 405.
- Board API, person actions, project CRUD, setup mint/mask/rotate, member-token remote routes, forwarding to a loopback shared space (Connector track, under wrangler dev).
- Crypto round trips and tamper detection (20 unit tests in the Workers runtime).
- Passkey registration, PRF unlock, recovery-code unlock, lock (Playwright, Chromium).
- `wrangler deploy --dry-run` validates the config and bundles.

## Not verified (needs a real deploy)

- Deploy to Cloudflare button end to end, including whether the button commits the database id into the fork (which would break fast-forward release sync; `SYNC_ALLOW_MERGE=true` is the fallback). See `docs/progress/deploy.md`.
- Two real Workers forwarding to each other (shared space). Only a loopback test was run.
- Duet and ChatGPT actually calling the connector. Cowork should work via the account's connectors.
- GitHub Actions (sync and health check) have not run on GitHub.

## Open issues (orchestrator's list)

From the security review, not yet fixed (findings 3, 4, 5, 9 in `docs/review/security-review-1.md`):
- `?` Public keys are not pinned: a personal copy encrypts to whatever key the shared space serves. Someone who can write the shared space's database could substitute a key. Fix: pin at connect time; vault checks the current public key matches a private key it holds.
- `?` Rotation after member removal fails open (toast only, no retry). Fix: block the UI until rotation succeeds, with a retry button.
- `?` Envelopes are bound to the key id only, not to their row or field. A database writer could move a note between items. Fix: add workstream id and field name to the authenticated data in a v2 envelope.
- `?` No Content-Security-Policy header yet. Fix: strict CSP on the dashboard response.

Earlier items:

1. `?` Forwarding has no retry. If a shared space misses the first `started` for a workstream, later events for it are refused (409) and never forwarded. Fix: an outbox table and a retry on the next report, or synchronous forwarding with a timeout.
2. `?` After a shared space rotates its key, a member's personal board shows new shared items as locked until the member reconnects. Fix: a member-token endpoint that serves the member's `user_pub` wraps.
3. `?` A recovery code decrypts but does not sign in. Losing every passkey means no way back in. Fix: a recovery-derived verifier that permits registering a new passkey.
4. `?` Whoever opens a fresh deploy first becomes owner. Fix: a `SETUP_TOKEN` the deployer sets, or accept and document (the README already says to open it right away).
5. `?` No rate limiting on the unauthenticated sign-in endpoints.
6. `?` ECIES does not bind the ephemeral public key into the key derivation (v2 envelope should).
7. `?` `wrapped_keys.key_id` has a foreign key to `space_keys`, so wraps of the user's own key and of remote shared keys store the local kid in that column while the real kid sits inside the wrap. Works, but a dedicated column would be cleaner.

## Open questions for Chris

1. GitHub repository name and owner for the push (suggest `chrisgachot/mission-control`, public, empty).
2. Project names are plaintext on the server so agents can pick them (PLAN.md decision 2). OK?
3. License: README says MIT as a placeholder.
4. Duet connector test needs a real deploy and a Duet session.
