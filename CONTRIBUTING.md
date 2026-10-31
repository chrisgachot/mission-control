# Contributing to Mission Control

## Local setup

```sh
npm install --legacy-peer-deps   # first time; the lockfile needs this flag
npm run migrate:local            # apply migrations/ to the local D1
npm run dev                      # build the dashboard and start wrangler dev on http://127.0.0.1:8787
npm run seed:local               # in a second terminal, once wrangler dev is up: fill the local D1 with sample data
npm test                         # vitest, inside the Workers runtime
npm run typecheck                # tsc --noEmit
```

`npm run seed:local` prints the connector URL, a recovery code and the steps to unlock the dashboard locally. It runs once per database. To start over, stop `wrangler dev`, delete `.wrangler/state/v3/d1` yourself, and run `npm run migrate:local` again.

## File ownership

Each area has one owner, so parallel work does not collide. Ask before editing a file outside your area.

| Area | Files |
| --- | --- |
| Connector | `src/mcp/**`, `src/db/**`, `src/api/{board,projects,workstreams,setup,ingest,remote}.ts`, `src/forward.ts`, `src/status.ts` |
| Security | `src/crypto/**`, `src/auth/**`, `src/api/{auth,keys,invites,members,remote-spaces}.ts`, `src/middleware/session.ts`, `web/src/vault.ts` |
| Dashboard | `web/src/**` (except `vault.ts`), `public/index.html`, `public/styles.css` |
| Deploy | `README.md`, `.github/**`, `wrangler.jsonc`, `docs/{DEPLOY,UPDATES,CONNECT}.md`, `src/setup-content.ts`, `scripts/release.mjs` |
| Support | `scripts/seed.mjs`, `test/**`, `docs/REPORTING-RULES.md`, `CONTRIBUTING.md` |
| Orchestrator | `docs/PLAN.md`, `docs/PROGRESS.md`, `docs/ARCHITECTURE.md`, `migrations/**`, `src/types.ts`, `src/index.ts`, `src/env.d.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/build-web.mjs` |

The contracts live in `docs/ARCHITECTURE.md`. Change a contract only through the orchestrator.

## Rules

- **Never delete files.** Archive rows instead (`archived_at`). If a file is wrong, replace its contents and say so in the log.
- **No plaintext in logs.** Log `event`, `requestId` and ids, never titles, notes, keys or tokens.
- **Keep `docs/PROGRESS.md` current.** Add a line for each change you make, and note anything you are unsure of with `?`. Each track also keeps its own log in `docs/progress/<track>.md`.
- **Only the Security track touches `src/crypto/**`.** Other code imports from it and does not reimplement crypto.
