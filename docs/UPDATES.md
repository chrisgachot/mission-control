# Updates

Every person runs their own copy, so updates have to reach each copy without anyone doing anything. The design: upstream publishes **tagged releases**; each copy has a scheduled GitHub Action that moves its `main` to the newest tag; the push makes Workers Builds redeploy; a second Action checks the new version is healthy and can roll back.

```
upstream main --tag vX.Y.Z-->  fork: sync-release.yml (daily)
                                   | fast-forward main, push
                                   v
                               Workers Builds: npm run build, then npm run deploy
                                   (D1 migrations, then wrangler deploy)
                                   |
                                   v
                               health-check.yml: poll /api/health for the new version
                                   | unhealthy + secrets present
                                   v
                               wrangler rollback --message "health check failed"
```

## Releasing (maintainer: Chris)

Only tags are pulled by copies. Work on `main` that is not tagged never reaches anyone.

1. Make sure `main` is green: `npm run typecheck && npm test`.
2. Bump the version and get the commands: `npm run release -- patch` (or `minor`, `major`, or an explicit `1.2.3`). The script edits `package.json` (and `package-lock.json`) and **prints** the git commands. It never runs git.
3. Run the printed commands: commit, push `main`, create the annotated tag `vX.Y.Z`, push the tag.
4. Within a day (06:17 UTC), every copy picks it up. Copies can also run the workflow by hand (Actions > Sync upstream release > Run workflow).

Rules for a release that is safe to auto-apply to everyone:

- **Migrations are additive.** Rollback changes the code, not the database. Add tables and columns; do not drop or rename something the previous release still reads. Remove old columns one release after the code stops using them.
- Tag only commits that pass the tests. Copies deploy whatever the tag points at.
- Use plain `vMAJOR.MINOR.PATCH` tags. Pre-release tags such as `v1.0.0-rc1` are ignored by the sync.
- Do not rewrite or move a published tag. A copy that already moved to it cannot fast-forward to a different commit.
- Do not commit a real `database_id` to upstream `wrangler.jsonc`; it holds the placeholder the button replaces.

## The sync workflow (`.github/workflows/sync-release.yml`)

- Runs daily at 06:17 UTC and on demand (`workflow_dispatch`).
- Skipped entirely in the upstream repository (`github.repository == 'chrisgachot/mission-control'`).
- Adds `https://github.com/chrisgachot/mission-control.git` as the `upstream` remote, fetches its `v*` tags, and picks the highest `vX.Y.Z` (version sort).
- Compares with the copy's `main`:
  - same commit: nothing to do;
  - the copy already contains the tag (it is ahead): nothing to do;
  - the copy is strictly behind: `git merge --ff-only`, then `git push origin HEAD:main` with the built-in `GITHUB_TOKEN`;
  - anything else (the copy has commits upstream does not, or the histories differ): the run **fails with an error message and changes nothing**. No pull request is opened.
- After a push it starts `health-check.yml` itself with `gh workflow run`, because pushes made with `GITHUB_TOKEN` do not trigger other workflows.
- Workers Builds then builds and deploys `main`. Whether Workers Builds reacts to a push made by `GITHUB_TOKEN` (it listens to GitHub's push webhook, not to Actions) is **unconfirmed**. If a sync run is green but no new deployment appears, that is the first thing to check; the fix is to give the workflow a personal access token as the `SYNC_TOKEN` secret, whose pushes behave like a normal user's.

### Known ways it stops, and what to do

| Symptom | Cause | Fix |
| --- | --- | --- |
| Red run: "Cannot fast-forward main" | The copy has its own commits. **Likely for button-created copies**, because Cloudflare writes the new D1 `database_id` (and possibly the Worker name) into the copy's `wrangler.jsonc`. Whether that is a commit in the new repository, and whether the copy shares history with upstream at all, is **unconfirmed**. | Set the repository variable `SYNC_ALLOW_MERGE` to `true`. The workflow then does a normal merge of the tag when it is clean, and still stops with an error on a conflict. Conflicts in `wrangler.jsonc` are the likely ones: keep your `database_id` and `name`, take everything else. |
| Red run: "changes files under .github/workflows" | `GITHUB_TOKEN` is never allowed to push changes to workflow files. | Add a repository secret `SYNC_TOKEN`: a personal access token (classic, `repo` and `workflow` scopes, or a fine-grained token with Contents and Workflows write on this repository). Or update by hand once. |
| No runs at all for weeks | GitHub disables scheduled workflows after 60 days without repository activity. | Re-enable in the Actions tab, or run it once by hand. Deploys and syncs count as activity, so this should only happen to a copy that never updates. |
| Workflow does not exist | Actions disabled on the new repository. | Actions tab > enable workflows. |

### Turning automatic updates off

GitHub > the copy's repository > Actions > **Sync upstream release** > the "..." menu > **Disable workflow**. Nothing else changes; the copy keeps running its current version. To update later, enable it again or run it once by hand. You can also delete `.github/workflows/sync-release.yml` from your copy.

To pin to a version deliberately, disable the workflow and, in the copy, reset `main` to the tag you want (`git fetch` the upstream tag, then `git reset --hard vX.Y.Z` and force-push). That is a manual, git-savvy operation and the health check will treat it like any other push.

## The health check and rollback (`.github/workflows/health-check.yml`)

Runs on every push to `main` in a copy (and on demand). It needs one repository **variable**, `APP_URL`, and optionally two **secrets** for rollback. Setup is in [DEPLOY.md](DEPLOY.md#5-health-check-and-rollback-optional-recommended).

1. Polls `${APP_URL}/api/health` every 20 seconds for up to 10 minutes, waiting for a `version` that contains the first 7 characters of the pushed commit. Mission Control sets `version` to `<package version>+<sha7>` on every deploy (`scripts/deploy.mjs`), so the match proves the new build is the one serving traffic.
2. **Healthy** (`ok: true`): the run is green.
3. **Unhealthy** (new version live, three bad answers in a row, for example `db: "error"`): with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` present, runs `npx wrangler rollback --message "health check failed"`, which re-activates the previous version, then prints the health after the rollback. The run still ends red so you get GitHub's failure email.
4. **Unknown** (the new version never appeared in 10 minutes): red run, no rollback. Usually the build failed (check Cloudflare > Worker > Deployments > View build history, kept 90 days); the old version is still serving.
5. No `APP_URL`: the workflow logs a notice and does nothing.

After a rollback the copy's `main` still contains the bad commit. The next daily sync will find nothing newer and leave things alone, and the health check will not run again until another push. Ship a fixed release (`vX.Y.Z+1`) and the copy moves forward. Until then the Worker runs the old code from the rollback.

Limits worth knowing (Cloudflare's rollback docs): rollback does not touch D1 data; it is blocked if D1 or KV resources were deleted or modified between the versions; only the 100 most recent versions are available.
