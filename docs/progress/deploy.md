# deploy track progress

Newest first. Mark uncertainty with ?.

## Status: done (2026-10-31)

### Files written
- `wrangler.jsonc`: kept bindings DB, ASSETS; vars SPACE_NAME, SPACE_KIND, APP_VERSION; `nodejs_compat`; `migrations_dir`. Kept `build.command = "npm run build:web"` (so any `wrangler deploy` or `wrangler dev` builds `public/app.js`, which is gitignored). Added comments. `database_id` stays the all-zero placeholder (see unconfirmed #1).
- `package.json` scripts block only: `deploy` is now `node scripts/deploy.mjs`; added `release` (`node scripts/release.mjs`). `build`, `build:web`, `dev` untouched. Workers Builds will pre-fill Build command `npm run build` and Deploy command `npm run deploy`.
- `scripts/deploy.mjs` (new): applies D1 migrations by binding name (`wrangler d1 migrations apply DB --remote`), then `wrangler deploy --message ... --var APP_VERSION:<pkg version>+<sha7>` plus `--var SPACE_NAME/SPACE_KIND` when set in the build environment. `--dry-run` prints the commands only. Tested with `--dry-run`, including a bad SPACE_KIND.
- `scripts/release.mjs` (new): bumps package.json (and package-lock.json) version, prints the git commands. Tested on a copy in /tmp.
- `src/setup-content.ts`: real `connectInstructions` (claude, claudeCode with `{CONNECTOR_URL}`, chatgpt, reportingRules).
- `README.md`, `docs/DEPLOY.md`, `docs/UPDATES.md`, `docs/CONNECT.md`.
- `.github/workflows/sync-release.yml`, `.github/workflows/health-check.yml`.

### Verification
- `npx wrangler deploy --dry-run --outdir /tmp/mc-dry`: succeeds. Ran the custom build, "Read 0 files from the assets directory" (public/ has no index.html yet; Dashboard track), bindings listed: DB, ASSETS, SPACE_NAME, SPACE_KIND, APP_VERSION. With `--var APP_VERSION:abc1234 --var SPACE_NAME:Test` it also succeeds and shows the vars as `(hidden)`, confirming CLI vars override the config block (also read in wrangler's bundled source: cliVars are applied over the config bindings).
- `npx tsc --noEmit`: no errors in `src/` (including `src/setup-content.ts`). Remaining errors are in `test/*` (`cloudflare:test` types) and `web/src/board/*` (DOM `ParentNode` clash with workers-types), not mine.
- YAML: no yaml package in node_modules; parsed both workflows with Python `yaml.safe_load` (steps and triggers listed correctly) and read both twice. Not run on GitHub; no `git` was run per instructions, so the sync script's git logic is untested.

### Design decisions worth reviewing
1. **APP_VERSION = `<package version>+<sha7>`**, set by `scripts/deploy.mjs` via `--var`, not a build-time define. `/api/health` reads the runtime var, so a `--var` override at deploy is the only way a build can set it. The health check matches the pushed commit's first 7 chars inside `version`. The existing `git describe` fallback in `scripts/build-web.mjs` still covers the bundle's `__APP_VERSION__`; deploy.mjs also exports `APP_VERSION` into that build.
2. **Rollback only when the new version is live and unhealthy.** If the new version never appears (failed build), the workflow reports and does not roll back, because `wrangler rollback` with no id would take the working previous version back one more step.
3. **SPACE_NAME / SPACE_KIND via Workers Builds build variables**, read by deploy.mjs. Keeps the repo identical to upstream so fast-forward sync keeps working. Editing wrangler.jsonc is the documented fallback.
4. **sync-release.yml extras beyond the brief:** (a) starts health-check via `gh workflow run` because GITHUB_TOKEN pushes do not trigger workflows; (b) optional `SYNC_TOKEN` secret, needed only if a release touches `.github/workflows/*` (GITHUB_TOKEN may not push those); (c) optional repo variable `SYNC_ALLOW_MERGE=true` to allow a clean merge when fast-forward is impossible. All off by default; the default behaviour is exactly "fast-forward or fail loudly, no PR".
5. For the orchestrator: package.json supports a `cloudflare.bindings` object with per-binding descriptions shown on the button's setup page. Not needed (no secrets). `package.json` is yours, so I did not add it. A `LICENSE` file is not written (README says MIT placeholder).

### Unconfirmed (could not verify; please check on the first real deploy)
1. Whether the Deploy button accepts and replaces the all-zero placeholder `database_id`. Docs say it "updates [the config] with new resource IDs" and that repos "should include default values for resource names and IDs"; Cloudflare's own D1 template uses a real-looking UUID. Fallback documented in DEPLOY.md.
2. Whether the button commits the new IDs (and possibly a renamed Worker) into the new repository, and whether that repository shares git history with upstream. If it does commit, **the fast-forward sync will fail for button-created copies** (diverged history). Mitigation built in: `SYNC_ALLOW_MERGE=true`. Needs a real test.
3. Whether the deploy command in Workers Builds sees Build variables (docs: "available only during the build"; the deploy command runs in the same build container, probably yes).
4. Whether Workers Builds deploys after a push made by the Actions `GITHUB_TOKEN` (it listens to GitHub's push webhook, so probably yes). `SYNC_TOKEN` is the fallback.
5. Whether `Workers Scripts: Edit` alone is enough for `wrangler rollback` in CI. Workers Builds' own default token has more.
6. That `wrangler rollback --message "..."` is fully non-interactive in CI: docs say `--message` skips the confirmation and message prompts; `--yes` also exists in Wrangler 4.156.0 `--help` but is not in the docs page. I did not add `--yes`.
7. Whether the button setup page rewrites `name` in `wrangler.jsonc` when the person renames the Worker.
8. Claude Duet: no Anthropic page mentions Duet (checked claude.com/docs llms index). Whether it uses the account's connectors is unconfirmed, as the brief says.
9. Cowork: Anthropic's connectors page lists "Cowork: connectors and plugins" as a place connectors work, but no page we read states that a custom (URL) connector added in Customize > Connectors appears there. Treated as likely, labelled unconfirmed in CONNECT.md.
10. ChatGPT: every step is unconfirmed. help.openai.com, platform.openai.com and developers.openai.com are blocked in this environment; steps come from web search summaries of third-party guides and forum posts (Settings > Connectors > Advanced > Developer mode; Create; URL; "No authentication"; plans Plus/Pro/Business/Enterprise/Edu; "search"/"fetch" tool requirement reports). The menu label (Connectors vs Apps) is uncertain.
11. Claude.ai "No sign-in" option: confirmed in Anthropic docs (add-unlisted page: "No sign-in: anyone with access to the server URL can use the connector"). The exact dialog layout varies by organization (documented), so the steps say so.
12. Cloudflare account ID location in the dashboard and the "Edit Cloudflare Workers" token template contents were written from memory.

### Sources read
Reached through `raw.githubusercontent.com` (developers.cloudflare.com and blog.cloudflare.com were blocked by the network policy; the docs repository is the same source text):
- `cloudflare/cloudflare-docs` (branch production): `src/content/docs/workers/platform/deploy-buttons.mdx`; `workers/ci-cd/builds/index.mdx`, `configuration.mdx`, `build-image.mdx`; `workers/wrangler/configuration.mdx`; `workers/wrangler/commands/workers.mdx`; `workers/versions-and-deployments/rollbacks.mdx`. (`workers/wrangler/commands/general.mdx` and `d1.mdx` had nothing useful.)
- `cloudflare/templates` `d1-template`: `package.json`, `wrangler.json`, `README.md`.
- Local `npx wrangler --help` for `deploy`, `rollback`, `d1 migrations apply` (4.156.0), and wrangler's bundled `cli.js` for `--var` handling.
- Anthropic: claude.com/docs/connectors (Get started with connectors), claude.com/docs/connectors/custom/add-unlisted.md (Add a connector that isn't in the directory), claude.com/docs/connectors/building/troubleshooting.md, claude.com/docs/llms.txt, code.claude.com/docs/en/mcp (including "Use MCP servers from claude.ai"), support.claude.com article 11175166 (custom connectors via remote MCP).
- Web search summaries only (not pages): Cloudflare blog "Deploy Workers applications in seconds"; Cloudflare changelog 2025-10-24 automatic resource provisioning; third-party ChatGPT developer-mode guides (Medium, zuplo, customer.io, auth0, qonto, terminal49, latenode) and OpenAI community forum threads.

### Not reachable
developers.cloudflare.com, blog.cloudflare.com, help.openai.com, platform.openai.com, developers.openai.com, docs.customer.io, zuplo.com (network policy; getaddrinfo ENOTFOUND). They would need to be allowed to confirm the items above.
