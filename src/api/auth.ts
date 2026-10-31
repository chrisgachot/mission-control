// STUB: replaced by its track (see docs/ARCHITECTURE.md §7).
import { Hono } from 'hono';
import type { AppEnv } from '../env.d.ts';
export const router = new Hono<AppEnv>();
router.all('*', (c) => c.json({ error: { code: 'not_implemented', message: 'auth not implemented yet' } }, 501));
