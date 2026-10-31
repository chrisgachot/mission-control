/** Builds a fresh MCP server per request (stateless transport). */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { REPORTING_RULES, registerTools } from './tools.ts';
import type { ToolContext } from './tools.ts';

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'mission-control', version: ctx.env.APP_VERSION || 'dev' },
    { instructions: REPORTING_RULES },
  );
  registerTools(server, ctx);
  return server;
}
