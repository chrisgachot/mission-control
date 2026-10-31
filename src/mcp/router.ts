// STUB: replaced by the Connector track.
import { Hono } from 'hono';
import type { AppEnv } from '../env.d.ts';
export const router = new Hono<AppEnv>();
router.all('*', (c) => c.json({ error: { code: 'not_implemented', message: 'mcp not implemented yet' } }, 501));
