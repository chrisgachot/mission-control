/**
 * STUB. The Security track replaces this file. Contract: docs/ARCHITECTURE.md §3 "Session".
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.d.ts';
import type { Role } from '../types.ts';

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  await next();
};

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) return c.json({ error: { code: 'unauthorized', message: 'Unlock first.' } }, 401);
  await next();
};

export const requireRole =
  (roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const u = c.get('user');
    if (!u) return c.json({ error: { code: 'unauthorized', message: 'Unlock first.' } }, 401);
    if (!roles.includes(u.role)) return c.json({ error: { code: 'forbidden', message: 'Not allowed.' } }, 403);
    await next();
  };
