/** ALL /mcp/:token. Token auth, then a stateless Streamable HTTP MCP server per request. */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { AppEnv } from '../env.d.ts';
import { findConnectorToken, touchConnectorToken } from '../db/tokens.ts';
import { waitUntilOf } from '../api/_http.ts';
import { createMcpServer } from './server.ts';

export const router = new Hono<AppEnv>();

router.all('/:token', async (c) => {
  const token = c.req.param('token');
  const owner = token ? await findConnectorToken(c.env.DB, token) : null;
  if (!owner) {
    return c.json({ error: { code: 'unauthorized', message: 'Unknown or revoked connector link.' } }, 401);
  }
  const waitUntil = waitUntilOf(c);
  waitUntil(touchConnectorToken(c.env.DB, owner.tokenId, Date.now()));

  const method = c.req.method;
  if (method !== 'POST') {
    return c.json(
      {
        error: {
          code: 'method_not_allowed',
          message: 'This connector is stateless. Send JSON-RPC requests with POST; there is no SSE stream to open.',
        },
      },
      405,
      { Allow: 'POST' },
    );
  }

  const server = createMcpServer({
    env: c.env,
    user: { id: owner.userId, handle: owner.handle },
    waitUntil,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
