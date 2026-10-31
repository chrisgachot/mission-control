// Connector instructions shown on the dashboard's setup page (served by src/api/setup.ts).
// Keep in step with docs/CONNECT.md, which is the longer human-readable version.
//
// The UI replaces {CONNECTOR_URL} with the person's connector link. Steps marked "(unconfirmed)"
// were not verified against the vendor's own documentation when this was written.
import type { ConnectInstructions } from './types.ts';

export const connectInstructions: ConnectInstructions = {
  claude: [
    'Open claude.ai in a browser, or the Claude desktop app, and go to Customize > Connectors (claude.ai/customize/connectors).',
    'Click Add custom connector (on some screens: + Add, then Add custom connector). Team and Enterprise: only an Owner can add it, under Organization settings > Connectors > Add > Custom > Web; members then open Customize > Connectors, find it and click Connect.',
    'Name it "Mission Control" and paste your connector link as the remote MCP server URL.',
    'If it asks how people connect, choose "No sign-in". The link itself is the secret, so keep it private. Do not add request headers or OAuth settings. Click Add.',
    'In a chat, click + > Connectors and switch Mission Control on for that conversation. Ask "list my Mission Control projects" to test it.',
    'Cowork uses the connectors on your Claude account, so it should pick this one up with no extra steps. Claude Duet: unconfirmed. Third-party guides say Duet can use remote custom connectors added to your Claude account, but Anthropic has not confirmed it. Test early.',
    'Free plan accounts can add one custom connector. Connections come from Anthropic\'s servers, so the link must be reachable from the public internet (a workers.dev address is).',
  ],
  claudeCode: [
    'claude mcp add --transport http --scope user mission-control {CONNECTOR_URL}',
    'Use --scope user so it is available in every project. Do not use --scope project: that writes the link into .mcp.json, which usually gets committed to git.',
    'Check it with: claude mcp list (Mission Control should say Connected). Inside a session, /mcp shows the same.',
    'If you are signed in to Claude Code with your claude.ai account and already added the connector on claude.ai, Claude Code picks it up automatically under /mcp and you do not need the command. A server added with claude mcp add takes precedence over the claude.ai one with the same URL.',
  ],
  chatgpt: [
    'ChatGPT needs Developer mode for custom MCP connectors. The exact steps below are unconfirmed (OpenAI\'s own help pages could not be read when this was written) and the menus change often.',
    'On chatgpt.com, open Settings > Connectors (unconfirmed; may be labelled Apps or Apps & Connectors) > Advanced, and turn on Developer mode (unconfirmed). Plans: reported for Plus, Pro, Business, Enterprise and Edu, not Free (unconfirmed). On Business, Enterprise and Edu a workspace admin may have to allow it.',
    'Go back to the connectors list and click Create (unconfirmed; may be labelled Add custom connector).',
    'Name: Mission Control. MCP server URL: paste your connector link. Authentication: No authentication. Accept the custom-connector warning and click Create.',
    'In a new chat, enable the connector from the + menu (Developer mode / More, unconfirmed), then ask "list my Mission Control projects" to test it.',
  ],
  reportingRules:
    'I use Mission Control to follow your work. At the start of meaningful work, call list_projects, pick the matching project (you cannot create one), and call report_started with a short imperative title. After that, report only when state changes: report_milestone for one-line progress such as "tests passing", report_waiting when you need me (say exactly what, for example "approve $214" or "pick a timeout"), and report_done with a one-line result. Never report every step. If you were given a workstream id or external id earlier, reuse it instead of starting a new one.',
};
