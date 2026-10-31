# support track progress

Newest first. Mark uncertainty with ?.

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

