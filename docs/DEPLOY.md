# Deploying Mission Control

Each person (and each shared space) runs their own copy: one Cloudflare Worker, one D1 database, no other services. The **Deploy to Cloudflare** button does the setup. This page explains what it does, which commands run on every deploy, and how to set up the optional health check with automatic rollback.

Sources are listed at the end. Anything marked **unconfirmed** was not verified against Cloudflare's documentation and should be checked on the first real deploy.

## 1. The button

Markdown (this is what the README uses):

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chrisgachot/mission-control)
```

URL form: `https://deploy.workers.cloudflare.com/?url=<public repo url>`.

Constraints from Cloudflare's docs:

- The repository must be **public**, on **github.com** or **gitlab.com** (self-hosted instances are not supported).
- The app must be a **Workers** application (Pages is not supported).
- The Wrangler config must sit at the repository root (or the URL must point at a subdirectory that is fully self-contained, including its dependencies). Ours is at the root: `wrangler.jsonc`.

## 2. What the button does

From Cloudflare's Deploy Buttons page:

1. Cloudflare **clones the repository into the person's own GitHub account** (a new repository they own, so they can keep developing it).
2. A setup page lets them choose the repository name, Worker name and the names of the resources.
3. Cloudflare reads `wrangler.jsonc` to see what the app needs, **provisions those resources** (here: the D1 database) and **updates the config in the new repository with the new resource IDs**. Cloudflare's docs ask repositories to "include default values for resource names and IDs", which is why `wrangler.jsonc` carries the placeholder `database_id` `00000000-0000-0000-0000-000000000000`.
4. It connects the new repository to **Workers Builds**, builds, and deploys. Every later push to the production branch (`main`) builds and deploys again. Pushes to other branches create preview deployments.

What Mission Control declares for this:

| Thing | Where | Notes |
| --- | --- | --- |
| Worker `mission-control` | `name` in `wrangler.jsonc` | The Worker name in the dashboard must match `name` in the config or the build fails (Workers Builds docs). The button lets the person rename it. Whether it also rewrites `name` in the cloned config is **unconfirmed**. |
| D1 database, binding `DB`, name `mission-control` | `d1_databases` | Created by the button. Migrations come from `migrations/`. |
| Static assets, binding `ASSETS`, from `public/` | `assets` | Dashboard files, built by `npm run build:web`. |
| Variables `SPACE_NAME`, `SPACE_KIND`, `APP_VERSION` | `vars` | Plain text. No secrets exist: there is nothing to enter on the setup page. |

There is no `.dev.vars.example` or `.env.example` because the Worker needs no secrets. (If a secret is ever added, list it in `.dev.vars.example` and the button will ask for it.)

**Unconfirmed:** whether the button accepts the all-zero placeholder UUID and replaces it. Cloudflare's own D1 template ships a real-looking UUID instead, and the docs only say IDs are updated. If the first real deploy fails at the migration step with a D1 "not found" error, set `database_id` to the ID shown in Workers & Pages > D1 for the new database, commit, and tell the orchestrator so the placeholder can be changed. The alternative is to delete `database_id` and rely on Wrangler's automatic provisioning; Cloudflare's configuration docs say that for deploys from GitHub the generated IDs "will not be written back to your repository", and we could not confirm that `wrangler d1 migrations apply` provisions on its own, so we did not choose it.

## 3. Build and deploy commands

Workers Builds reads the `build` and `deploy` scripts in `package.json` and pre-fills the two fields; the person can edit them. Cloudflare recommends putting D1 migrations in the deploy step and referring to the database by **binding name** so that a renamed database still works.

| Field | Value | Why |
| --- | --- | --- |
| Build command | `npm run build` | Pre-filled from `package.json`. Bundles the dashboard into `public/app.js` (`scripts/build-web.mjs`). Dependencies are installed automatically by Workers Builds. |
| Deploy command | `npm run deploy` | Pre-filled from `package.json`. Runs `node scripts/deploy.mjs`, below. |
| Root directory | empty | The config is at the repo root. |
| Production branch | `main` | Default. |

`scripts/deploy.mjs` does two things, in this order, and stops on the first failure:

1. `npx wrangler d1 migrations apply DB --remote`. Applies unapplied files from `migrations/`. In a non-interactive environment Wrangler skips its confirmation prompt and still takes a backup. A failed migration is rolled back and the deploy does not continue, so a bad migration leaves the old version running.
2. `npx wrangler deploy --message "Mission Control <version>" --var APP_VERSION:<version> [--var SPACE_NAME:...] [--var SPACE_KIND:...]`.

**Which place builds the dashboard:** `wrangler.jsonc` has `"build": {"command": "npm run build:web"}`, so every `wrangler deploy` and `wrangler dev` builds the dashboard itself. That is deliberate: a deploy can never go out without `public/app.js` (which is not committed). It means the dashboard is bundled twice in Workers Builds (once by the Build command, once inside `wrangler deploy`). The second build is a fraction of a second, and it is the one that sees `APP_VERSION`. If you prefer a single build, set the Build command field to empty; nothing else changes.

Wrangler version: Workers Builds uses the version in `package.json` (`wrangler` `^4.156.0`).

### APP_VERSION

`GET /api/health` returns `version` from the `APP_VERSION` variable. `scripts/deploy.mjs` sets it on every deploy to `<package.json version>+<first 7 characters of the commit sha>`, for example `0.2.0+a1b2c3d`:

- The commit sha comes from `WORKERS_CI_COMMIT_SHA`, which Workers Builds injects (documented: `CI=true`, `WORKERS_CI=1`, `WORKERS_CI_BUILD_UUID`, `WORKERS_CI_COMMIT_SHA`, `WORKERS_CI_BRANCH`). If that is missing it uses `GITHUB_SHA`, then `git rev-parse`, then `dev`.
- The package version is bumped by `npm run release` (see [UPDATES.md](UPDATES.md)). When the sync workflow fast-forwards a fork to tag `v0.2.0`, the fork's commit is exactly the tagged commit, so its sha and version match upstream.
- `--var` overrides the `vars` block of `wrangler.jsonc` (confirmed in Wrangler's source and with `wrangler deploy --dry-run`). Values passed this way are stored as plain text variables.
- The same value goes into the dashboard bundle through the `APP_VERSION` environment variable that `scripts/build-web.mjs` reads.
- Local `npm run dev` leaves it at `dev`.

You can set `APP_VERSION` yourself as a Workers Builds build variable to override all of this.

### Deploying by hand (no button)

```sh
npm install --legacy-peer-deps
npx wrangler login
npx wrangler d1 create mission-control      # copy the database_id it prints into wrangler.jsonc
npm run deploy
```

## 4. After the first deploy

1. Open the Worker URL (shown in the Cloudflare dashboard, `https://<worker-name>.<account-subdomain>.workers.dev`). The first visit creates the owner passkey. Do this straight away: setup is open to whoever gets there first until it is done.
2. Save the recovery code, copy the connector link, and add it to your tools ([CONNECT.md](CONNECT.md)).
3. Optional: set up the health check (next section).

## 5. Health check and rollback (optional, recommended)

`.github/workflows/health-check.yml` runs on every push to `main` of the person's copy. It waits up to 10 minutes for the new version to appear at `/api/health` (matching the commit sha in `version`), and:

- **healthy**: done.
- **unhealthy** (the new version is live but `ok` is false three polls in a row): if the secrets below exist it runs `npx wrangler rollback --message "health check failed"`, which makes the previous version the active deployment. Without secrets it only reports (red run, email from GitHub).
- **unknown** (the new version never appeared, usually a failed build): reports only. It deliberately does not roll back, because the previous version is probably the good one still serving.

Setup, in the person's own GitHub repository (Settings > Secrets and variables > Actions):

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `APP_URL` | The Worker URL, for example `https://mission-control.example.workers.dev`. Without it the workflow does nothing. |
| Secret | `CLOUDFLARE_API_TOKEN` | A token with **Account > Workers Scripts > Edit** for your account. Create it at dash.cloudflare.com > My Profile > API Tokens > Create Token (the "Edit Cloudflare Workers" token template should include it; unconfirmed, written from memory). |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Your account ID (shown in the Cloudflare dashboard, for example on the Workers & Pages overview page; unconfirmed where exactly). |

Caveats:

- Rollback only changes which code runs. **It does not undo D1 migrations.** Cloudflare's rollback docs say resources connected to the Worker are not changed and that older code can fail if the data structure changed. Write migrations that are additive (new tables or columns, nothing dropped or renamed in the same release as the code that stops using it).
- Rollback is blocked if D1 or KV resources were deleted or modified between the two versions (Cloudflare docs). You can only roll back to the 100 most recent versions.
- Whether "Workers Scripts: Edit" alone is enough for `wrangler rollback` is **unconfirmed**; the Workers Builds default token has Workers Scripts, KV, R2 and Routes edit plus read access to account settings and user details. If rollback fails with a permissions error, add what the error names.
- You can always roll back by hand: Cloudflare dashboard > Workers & Pages > your Worker > Deployments > pick a version > Rollback; or `npx wrangler rollback <version-id> --message "reason"`.

## 6. Shared space (Light Hill)

A shared space is the same code deployed a second time, in its own Cloudflare account or the same one, with its own D1 database. It differs only by two variables:

| Variable | Value |
| --- | --- |
| `SPACE_KIND` | `shared` |
| `SPACE_NAME` | `Light Hill` |

Two ways to set them:

1. **Build variables (recommended).** During the button's setup page, or later in Workers & Pages > the Worker > Settings > Build > Variables and secrets, add `SPACE_KIND=shared` and `SPACE_NAME=Light Hill`. `scripts/deploy.mjs` passes them to `wrangler deploy --var`. No file in the repository changes, so the sync workflow can still fast-forward. Builds started after you save use the new values; retry the last build to apply them now. Whether the **deploy command** sees build variables (the docs say they are available "only during the build") is **unconfirmed**; if `/api/health` still shows the default name, use option 2.
2. **Edit `wrangler.jsonc` in the copy.** Change the two lines in `vars` and commit to `main`. This makes the repository diverge from upstream, so the sync workflow will refuse to fast-forward until you set the repository variable `SYNC_ALLOW_MERGE=true` (see [UPDATES.md](UPDATES.md)).

Do not use the Cloudflare dashboard's Settings > Variables for these: `wrangler deploy` replaces dashboard-defined variables with the ones in the config unless `--keep-vars` is passed (Wrangler's `--keep-vars` help text).

Then open the URL, create the admin passkey, save the recovery code, and invite members from the dashboard. Each member's personal copy connects to it with the link the invite flow gives them.

## 7. Sources read

Read during this build (2026-10-31):

- Cloudflare, Deploy to Cloudflare buttons: `src/content/docs/workers/platform/deploy-buttons.mdx` in the `cloudflare/cloudflare-docs` repository (the same text as developers.cloudflare.com/workers/platform/deploy-buttons/, which this environment could not reach).
- Cloudflare, Workers Builds overview and configuration: `workers/ci-cd/builds/index.mdx` and `configuration.mdx`, and the build image page `build-image.mdx`, same repository.
- Cloudflare, Wrangler configuration (`d1_databases`, automatic provisioning, `vars`, `build`): `workers/wrangler/configuration.mdx`.
- Cloudflare, Wrangler commands (`deploy`, `rollback`, `versions`, `deployments`): `workers/wrangler/commands/workers.mdx`.
- Cloudflare, Rollbacks: `workers/versions-and-deployments/rollbacks.mdx`.
- Cloudflare template `d1-template` (`package.json`, `wrangler.json`, README) in `cloudflare/templates`: confirms the `predeploy`/`deploy` migration pattern with the binding name.
- `npx wrangler --help` output for `deploy`, `rollback` and `d1 migrations apply` (Wrangler 4.156.0, from `node_modules`), and Wrangler's bundled source for `--var` precedence.
- Cloudflare blog, "Deploy Workers applications in seconds" and the 2025-10-24 changelog on automatic resource provisioning: seen only as search-result summaries.

Not reachable from this environment (blocked by the network policy): developers.cloudflare.com, blog.cloudflare.com, help.openai.com, platform.openai.com, developers.openai.com.
