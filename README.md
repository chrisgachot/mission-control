# Mission Control

One private dashboard for everything your AI agents are doing, across Claude Code, Cowork, Claude chat, Duet and ChatGPT. Agents report when they start, hit a milestone, need you, or finish. You open one page and see what is running, what is waiting on you, and what has gone quiet.

It is a single Cloudflare Worker that you deploy to your own Cloudflare account. The same Worker is a remote MCP server (the "connector" your agents call), a small API, and the dashboard itself. Data lives in your own D1 database. Titles, notes, next steps and links are encrypted in your browser with a key that only your passkey can unlock. There is no shared service, no account to create with us, and nothing to host except what the button below sets up.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chrisgachot/mission-control)

The button copies this repository into your GitHub account, creates the Worker and its database in your Cloudflare account, and connects them so every change to your copy deploys automatically. You need a free Cloudflare account and a GitHub account. Details: [docs/DEPLOY.md](docs/DEPLOY.md).

## After deploying

1. Open your Worker's address (shown in the Cloudflare dashboard, `https://<name>.<you>.workers.dev`). Do it right away: whoever opens it first creates the owner passkey.
2. Create your passkey. This is how you unlock the dashboard from now on.
3. **Save your recovery code.** It is shown once. If your passkey device cannot unlock your data (not every browser supports the passkey feature we use, and devices get lost), the recovery code is the only other way in. Nobody, including us, can recover your data without the passkey or the code.
4. Copy your **connector link** (`https://<your-worker>/mcp/<secret>`). Treat it like a password.
5. Add it to Claude and ChatGPT as a custom connector with no sign-in, and add Claude Code with one command. Step by step, with troubleshooting: [docs/CONNECT.md](docs/CONNECT.md). Paste the short reporting rules from that page into your project instructions so agents know when to report.

Duet and ChatGPT support is unconfirmed until tested; see [docs/CONNECT.md](docs/CONNECT.md).

## Privacy

- **Encrypted so the server cannot read it:** workstream titles, notes and updates, next steps, and links. They are encrypted in your browser (or on arrival at the Worker, for what agents send) with your space's public key, using ECIES (P-256, HKDF-SHA256, AES-256-GCM). The matching private key is wrapped with a key derived from your passkey and, separately, with your recovery code. It exists decrypted only in your browser's memory while unlocked.
- **Readable by the server (plaintext):** project names (the connector hands them to agents so they can pick one), which tool reported (code, cowork, duet, chat, chatgpt), statuses, timestamps, and external ids agents use to resume a session. This is what lets the server work out "running", "waiting on you" and "stale (7+ days)" without decrypting anything.
- **Who holds the data:** your Cloudflare account. We run no server and receive nothing.
- **Known limit:** what an agent sends travels in plaintext over HTTPS to your Worker, which encrypts it before storing. The Worker never holds a private key and writes only ciphertext, but while it processes a request the text is in the Worker's memory. Someone who could change your Worker's code (that is, whoever controls your Cloudflare or GitHub account) could make it capture new reports. The connector link is the only credential agents use; rotate it from the setup page if it leaks.

## Updates

Your copy updates itself from tagged releases. A scheduled GitHub Action (`.github/workflows/sync-release.yml`) checks daily for the newest `vX.Y.Z` tag on the upstream repository and fast-forwards your `main` to it, which makes Cloudflare rebuild and redeploy; database migrations run first. Only tags are pulled, so untagged work in progress never reaches you. A second Action (`.github/workflows/health-check.yml`) then checks your Worker's `/api/health`, and if the new version is unhealthy it rolls back to the previous one (this needs a Cloudflare API token saved as a repository secret; without it, it only tells you). Turn automatic updates off by disabling the "Sync upstream release" workflow in your repository's Actions tab. Details, including what can stop a sync: [docs/UPDATES.md](docs/UPDATES.md).

## Shared spaces

A shared space, such as Light Hill, is the same Worker deployed a second time with `SPACE_KIND=shared` and `SPACE_NAME` set (see [docs/DEPLOY.md](docs/DEPLOY.md#6-shared-space-light-hill)). A shared project has its own encryption key, held by its members. Members join through an invite link whose secret sits after the `#` so the server never sees it. When an agent reports on a shared project, your personal copy forwards the update, encrypted with the shared key, to the shared space, and your own dashboard shows it alongside everything else. Removing a member rotates the shared key.

## Local development

```sh
npm install --legacy-peer-deps
npm run migrate:local   # create the local D1 database
npm run seed:local      # optional sample data
npm run dev             # builds the dashboard, then wrangler dev
```

`npm test` runs the tests, `npm run typecheck` checks the types. For the design and the HTTP contract, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Releases: [docs/UPDATES.md](docs/UPDATES.md).

## License

MIT (placeholder: Chris to confirm before the repository goes public; add a `LICENSE` file at that point).
