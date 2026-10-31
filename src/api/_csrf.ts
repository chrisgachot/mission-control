/** CSRF guard for state-changing session routes: requires `X-Requested-With: mission-control`. */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.d.ts';

export const requireCsrfHeader: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header('X-Requested-With') !== 'mission-control') {
    return c.json({ error: { code: 'csrf', message: 'Missing X-Requested-With header.' } }, 403);
  }
  await next();
};
