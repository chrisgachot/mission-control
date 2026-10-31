# Connecting your tools

Mission Control's connector is a remote MCP server at one secret address:

```
https://<your-worker>.workers.dev/mcp/<token>
```

Find it on the dashboard's setup page (copy it from there; it is shown in full once, right after setup, and masked afterwards, so keep a copy in your password manager). The token in the address is the only credential. Anyone with the link can report to your board and read your project names, so treat it like a password. You can rotate it from the setup page; the old link then stops working.

It is a plain URL with no sign-in, so every tool below is set up the same way: add a custom connector, paste the link, choose **no authentication**.

What agents can do through it: list your projects, start a workstream, post a one-line milestone, say they are waiting on you, mark done, and find earlier workstreams. They cannot create projects, read titles or notes, or see anything else in your account.

Status of the steps below: the Claude and Claude Code steps were read from Anthropic's documentation on 2026-10-31. **ChatGPT and Duet steps are unconfirmed** (see the notes in each section). Menus change; if a label differs, look for the nearest equivalent.

## Claude (web and desktop app)

Works on Free, Pro, Max, Ultra, Team and Enterprise plans. Free accounts can add one custom connector. On Team and Enterprise only an Owner (or, on Enterprise, a member with a custom role that can manage the organization's libraries) can add it.

Individual plans (Free, Pro, Max, Ultra):

1. Open claude.ai, or the Claude desktop app, and go to **Customize > Connectors** (claude.ai/customize/connectors).
2. Click **Add custom connector** (some versions: **+ Add**, then **Add custom connector**).
3. Name: `Mission Control`. Remote MCP server URL: your connector link.
4. If asked how people connect (Authentication), choose **No sign-in**. Leave OAuth and request headers empty.
5. Click **Add**.
6. In a chat, click **+** in the message box, then **Connectors**, and switch **Mission Control** on for that conversation.
7. Test: "List my Mission Control projects."

Team and Enterprise: an Owner goes to **Organization settings > Connectors**, clicks **Add**, hovers **Custom**, picks **Web**, enters the name and link, and clicks **Add**. Each member then opens **Customize > Connectors**, finds the connector (labelled Custom) and clicks **Connect**. Note that on these plans the connector, and therefore the link, is shared by the organization. For a personal Mission Control, use an individual account, or have only your own account's owner add it.

Claude tells you its connections come from Anthropic's servers, not your device. A workers.dev address is public, so this works with no network setup.

You may be asked to approve tool calls. **Always allow** for Mission Control is reasonable: the tools only write short status lines to your own board.

## Cowork

Anthropic's connector documentation lists Cowork among the apps that use connectors from your Claude account ("Cowork: connectors and plugins"). So add the connector in Claude as above and it should be available in Cowork. That a *custom* connector appears in Cowork with no extra step is the reading of that page, not something we tested: **unconfirmed until tried**. If it is missing, check Cowork's own connector or plugin settings.

## Claude Code

Add it with one command (user scope, so it is available in every project):

```sh
claude mcp add --transport http --scope user mission-control "https://<your-worker>.workers.dev/mcp/<token>"
```

Check: `claude mcp list` should show `mission-control` as connected; inside a session, `/mcp` shows the same.

- Do not use `--scope project`. That writes the link into `.mcp.json` in the repository, which usually gets committed. The default scope (`local`) keeps it in your `~/.claude.json` for the current project only.
- If you are signed in to Claude Code with your claude.ai account and already added the connector in Claude, Claude Code fetches it automatically; run `/mcp` to see it under the claude.ai entries. A server added with `claude mcp add` takes precedence over a claude.ai connector with the same URL. Connectors from claude.ai are not loaded when you use an API key, a third-party provider (Bedrock and so on) or a `claude setup-token` token instead of a claude.ai login.
- Remove with `claude mcp remove mission-control`.

## Claude Duet

**Unconfirmed.** Third-party guides say Duet can use remote custom connectors that are added to your Claude account, but Anthropic's documentation we could read does not mention Duet at all. Add the connector to Claude (above), then open Duet and look for Mission Control in its connector list or `+` menu. **Test this early**; if Duet cannot see it, the dashboard will simply never show Duet work, and everything else is unaffected. Please report what you find so these steps can be corrected.

## ChatGPT

**Unconfirmed.** OpenAI's own help pages could not be opened from our build environment, so these steps come from third-party guides and search summaries, and OpenAI moves these menus often.

1. On chatgpt.com, open **Settings > Connectors** (it may be labelled **Apps** or **Apps & Connectors**). Open **Advanced** and switch on **Developer mode**. Reported as available on Plus, Pro, Business, Enterprise and Edu, not on Free. On Business, Enterprise and Edu, a workspace admin may have to enable it or approve the connector.
2. Back in the connectors list, click **Create** (it may say **Add custom connector** or **Add MCP server**).
3. Name: `Mission Control`. MCP server URL: your connector link. Authentication: **No authentication**.
4. Accept the warning about custom connectors, and create it.
5. In a chat, enable the connector from the **+** menu (it may be under **Developer mode** or **More**), then ask: "List my Mission Control projects."

Known reports from forums (unverified): some people saw a "violates our guidelines" message when adding a no-authentication connector, and one report says ChatGPT expected `search` and `fetch` tools. Mission Control has neither. If ChatGPT refuses the connector, ChatGPT may be unable to report to Mission Control; the other tools are unaffected. Tell us what you see.

## Tell your agents when to report

A connected tool does nothing until the agent knows to use it. Paste this into your project instructions (Claude Projects, `CLAUDE.md`, ChatGPT project instructions). The server also sends a short version to every client when it connects.

> I use Mission Control to follow your work. At the start of meaningful work, call list_projects, pick the matching project (you cannot create one), and call report_started with a short imperative title. After that, report only when state changes: report_milestone for one-line progress such as "tests passing", report_waiting when you need me (say exactly what, for example "approve $214" or "pick a timeout"), and report_done with a one-line result. Never report every step. If you were given a workstream id or external id earlier, reuse it instead of starting a new one.

The same text is shown on the dashboard's setup page.

## Troubleshooting

| What you see | Likely cause | Fix |
| --- | --- | --- |
| **401** from the connector, or the tool says it cannot connect or is unauthorized | The link is wrong (a character lost when copying, a masked `••••` link pasted instead of the full one) or the token was rotated, which revokes the old link. | Open the setup page, copy the current link, remove the connector in the tool and add it again. Connector settings cannot be edited after the fact in Claude, so remove and re-add. If the page only shows a masked link, rotate the token to mint a new full one. |
| Claude says it "couldn't reach the MCP server" | The address is wrong, the Worker is down, or a firewall or WAF in front of a custom domain blocks Anthropic's servers. | Open `https://<your-worker>/api/health` in a browser: you should see `{"ok":true,...}`. If you use a custom domain with WAF rules, allow Anthropic's outbound range or exempt `/mcp/*`. Do not use a URL that redirects to another host. |
| Connector added but the agent never calls it | It is off in this conversation, or the agent was never told to use it. | Switch it on in the **+ > Connectors** menu. Add the instructions above to the project. |
| Claude Code does not show the connector | Wrong scope or typo, or a claude.ai connector but you are not logged in with a claude.ai account. | `claude mcp list`. Re-add with `--scope user`. Check `/status` for the login method. |
| Agents report to the wrong project, or say a project does not exist | Agents cannot create projects. | Create the project on the dashboard first. |
| Duet or ChatGPT cannot see it | Unconfirmed support (see the sections above). | Test early; report back. |
| After rotating the token everything stopped | The old link is revoked on purpose. | Update every tool with the new link. |
| Invalid server URL / HTTPS error | Missing `https://` or a stray quote or space. | Paste the link exactly as shown. |

Still stuck: the dashboard setup page shows when the token was created. `GET /api/health` tells you whether the Worker and its database are up and which version is live.
