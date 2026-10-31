/** GET /api/space (public): name, kind, setup state and the current public key. */
import { Hono } from 'hono';
import type { AppEnv } from '../env.d.ts';
import { getSpaceInfo } from '../db/spaces.ts';

export const router = new Hono<AppEnv>();

router.get('/', async (c) => c.json(await getSpaceInfo(c.env)));
