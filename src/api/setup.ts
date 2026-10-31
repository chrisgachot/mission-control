/**
 * GET /api/setup and POST /api/setup/rotate-token (session).
 * Only the token hash is stored, so the full connector URL is visible exactly once:
 * on the first mint, or right after a rotation. Later reads return a masked URL
 * (`https://<host>/mcp/••••`) with tokenCreatedAt.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env.d.ts';
import { apiError } from './_http.ts';
import { requireCsrfHeader } from './_csrf.ts';
import { getActiveConnectorTokenCreatedAt, mintConnectorTokenIfNone, rotateConnectorToken } from '../db/tokens.ts';
import { requireSession } from '../middleware/session.ts';
import { connectInstructions } from '../setup-content.ts';
import type { SetupResponse } from '../types.ts';

export const router = new Hono<AppEnv>();

const MASK = '••••';

function connectorUrl(c: Context<AppEnv>, token: string): string {
  return new URL(c.req.url).origin + '/mcp/' + token;
}

router.get('/', requireSession, async (c) => {
  const user = c.get('user');
  if (!user) return apiError(c, 401, 'unauthorized', 'Unlock first.');
  const now = Date.now();
  const minted = await mintConnectorTokenIfNone(c.env.DB, user.id, now);
  if (minted) {
    const body: SetupResponse = { connectorUrl: connectorUrl(c, minted), tokenMasked: false, tokenCreatedAt: now, instructions: connectInstructions };
    return c.json(body);
  }
  const createdAt = (await getActiveConnectorTokenCreatedAt(c.env.DB, user.id)) ?? now;
  const body: SetupResponse = { connectorUrl: connectorUrl(c, MASK), tokenMasked: true, tokenCreatedAt: createdAt, instructions: connectInstructions };
  return c.json(body);
});

router.post('/rotate-token', requireCsrfHeader, requireSession, async (c) => {
  const user = c.get('user');
  if (!user) return apiError(c, 401, 'unauthorized', 'Unlock first.');
  const now = Date.now();
  const token = await rotateConnectorToken(c.env.DB, user.id, now);
  const body: SetupResponse = { connectorUrl: connectorUrl(c, token), tokenMasked: false, tokenCreatedAt: now, instructions: connectInstructions };
  return c.json(body);
});
