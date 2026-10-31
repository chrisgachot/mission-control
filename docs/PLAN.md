# Mission Control: build plan

Source of truth: the Mission Control Build Spec (Claude doc, Oct 31, 2026). This file is the orchestrator's working plan. `PROGRESS.md` is the running log.

## What we are building

A single Cloudflare Worker per person that is, at once:

1. A remote MCP server (the "connector") that agents in Claude Code, Cowork, Claude chat, Duet and ChatGPT call to report `started`, `milestone`, `waiting on you`, `done`.
2. A JSON API the dashboard reads, with status, staleness and activity computed server-side from plaintext metadata.
3. The dashboard itself, served as static assets from the same Worker, decrypting titles and notes in the browser with a key that only the person's passkey can unlock.

Data lives in D1. Each person deploys their own copy with a Deploy to Cloudflare button. A third copy, the shared Light Hill space, receives forwarded updates on shared projects from each member's personal copy.

## Decisions the orchestrator settled (the spec left them open or implied)

| # | Decision | Why |
| --- | --- | --- |
| 1 | One Worker serves MCP, API and the dashboard (Workers Static Assets), not a separate Pages project | The Deploy button provisions one Worker plus its D1 database cleanly. Fewer moving parts per friend. Spec listed Pages; this is the same outcome with one deploy. |
| 2 | Project names are stored in plaintext | The connector must hand agents the project list by name so they can pick one. Titles, notes, next steps and links stay encrypted. Flagged as a deviation from the spec's encrypted list. |
| 3 | Encryption is ECIES: P-256 ECDH + HKDF-SHA256 + AES-256-GCM, with versioned space keys | WebCrypto supports it identically in Workers and every browser. Key versions make member removal (rotation) possible without re-encrypting history. |
| 4 | Private key is wrapped with a key derived from the passkey's PRF extension; a one-time recovery code is the fallback | PRF is the only way to tie a key to a passkey. Not every browser or authenticator supports it yet, so the recovery code exists. |
| 5 | Connector auth is a secret token in the URL path: `https://<worker>/mcp/<token>` | Claude and ChatGPT custom connectors accept a plain URL. No OAuth server to run. Token is rotatable from the setup page. |
| 6 | Shared-space invite link carries its secret in the URL fragment | The admin's browser wraps the shared key with that secret; the server stores only ciphertext; the invitee's browser unwraps it. Server never sees the key. |
| 7 | Stale = no agent activity for 7 days (constant, `STALE_AFTER_DAYS`) | Matches the mockup ("Stale, 7+ days"). |
| 8 | Tool identifiers: `code`, `cowork`, `duet`, `chat`, `chatgpt` | The mockup had four; the spec names ChatGPT too. |
| 9 | Release sync into each fork is a scheduled GitHub Action that fast-forwards `main` to the newest upstream `v*` tag | Answers the spec's open decision with a concrete proposal. Workers Builds then redeploys. See `docs/UPDATES.md`. |
| 10 | Vanilla TypeScript modules bundled with esbuild for the dashboard, no framework | The mockup is already vanilla and it keeps the port faithful and the dependency list short. |

## Build order and tracks

Spec order: (1) MCP server + D1 schema, (2) encryption + passkeys, (3) dashboard on real data, (4) deploy button + first run, (5) test with Chris, Kevin, a friend.

Tracks 1 to 4 run in parallel against the contracts in `docs/ARCHITECTURE.md`. File ownership per track is strict; the orchestrator integrates.

| Track | Worker | Owns |
| --- | --- | --- |
| Connector | Sonnet | `src/mcp/**`, `src/db/**`, `src/api/{board,projects,workstreams,setup,ingest,remote}.ts`, `src/forward.ts`, `src/status.ts` |
| Security | Opus | `src/crypto/**`, `src/auth/**`, `src/api/{auth,keys,invites,members,remote-spaces}.ts`, `src/middleware/session.ts`, `web/src/vault.ts` |
| Dashboard | Sonnet | `web/src/**` (except `vault.ts`), `public/index.html`, `public/styles.css` |
| Deploy | Sonnet | `README.md`, `.github/**`, `wrangler.jsonc`, `docs/{DEPLOY,UPDATES,CONNECT}.md`, `src/setup-content.ts`, `scripts/release.mjs` |
| Support | Haiku | `scripts/seed.mjs`, `test/**`, `docs/REPORTING-RULES.md`, `CONTRIBUTING.md` |

Orchestrator owns: `docs/PLAN.md`, `docs/PROGRESS.md`, `docs/ARCHITECTURE.md`, `migrations/**`, `src/types.ts`, `src/index.ts`, `src/env.d.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build-web.mjs`.

## Done means

- `npm run typecheck`, `npm test` pass.
- `wrangler dev` serves the dashboard with seeded data; an MCP client can `initialize`, `tools/list`, call `list_projects` and `report_started` through `/mcp/<token>`.
- Passkey setup, lock and unlock work in Chromium (Playwright with a virtual authenticator).
- Deploy button, first-run setup page and connector instructions are in the README.
- Encryption code has had a second independent review (orchestrator) before any friend deploys.

## Needs Chris

- A GitHub repository to push to (none exists yet; this session cannot create one).
- A Cloudflare account to run the first real deploy and a real Duet test.
