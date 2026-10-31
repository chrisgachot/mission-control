/**
 * Session + CSRF middleware (Security track). Contract: docs/ARCHITECTURE.md §3 "Session".
 * Mounted by src/index.ts on '/api/*', so every API route runs through loadSession.
 *
 * loadSession does three things, in this order:
 *
 * 1. CSRF check. Every state-changing request (POST, PUT, PATCH, DELETE) under /api must carry
 *    `X-Requested-With: mission-control`, else 403. A cross-site HTML form cannot set custom headers,
 *    and a cross-site fetch() that sets one triggers a CORS preflight that this Worker never approves
 *    (it sends no Access-Control-Allow-* headers). SameSite=Lax on the cookie is the second layer.
 *    Exempt: /api/remote/* (Worker-to-Worker forwarding, authenticated by a bearer member token, no
 *    cookie involved, so CSRF does not apply). Note the exemption is the exact segment "/api/remote"
 *    followed by "/" or end; "/api/remote-spaces" (cookie-authenticated) is NOT exempt.
 *    /mcp/* is not under /api and never reaches this middleware.
 *
 * 2. DEV BYPASS. If the optional binding DEV_BYPASS_USER_ID is set AND the request hostname is exactly
 *    `localhost` or `127.0.0.1`, the request is treated as that user (which must exist and not be
 *    removed). It exists only for `wrangler dev` and Playwright via .dev.vars. Two independent
 *    conditions must both hold: the variable is never set in wrangler.jsonc or as a production secret,
 *    and a deployed Worker is never reached under those hostnames (Cloudflare routes on the real host).
 *
 * 3. Session lookup. Cookie `mc_session` -> sha256 -> sessions row, unexpired, user not removed.
 *    Sets c.var.user to { id, handle, role } or null. Expired rows are deleted when seen.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.d.ts';
import type { Role } from '../types.ts';
import { getActiveUser, getSessionUser, deleteExpiredSession } from '../auth/db.ts';
import { isLocalHostname, readSessionCookie, sessionIdFor } from '../auth/sessions.ts';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'mission-control';

function csrfExempt(path: string): boolean {
  return path === '/api/remote' || path.startsWith('/api/remote/');
}

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const path = c.req.path;

  // 1. CSRF
  if (path.startsWith('/api/') && STATE_CHANGING.has(c.req.method) && !csrfExempt(path)) {
    if (c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
      return c.json({ error: { code: 'csrf', message: 'Missing X-Requested-With header.' } }, 403);
    }
  }

  const hostname = new URL(c.req.url).hostname;
  const now = Date.now();

  // 2. DEV BYPASS (localhost only; see header comment)
  const bypassId = c.env.DEV_BYPASS_USER_ID;
  if (bypassId && isLocalHostname(hostname)) {
    const u = await getActiveUser(c.env.DB, bypassId);
    if (u) {
      c.set('user', { id: u.id, handle: u.handle, role: u.role });
      await next();
      return;
    }
    // Unknown bypass id: fall through to the normal cookie path rather than failing open.
  }

  // 3. Cookie session
  const cookie = readSessionCookie(c);
  if (cookie) {
    const idHash = await sessionIdFor(cookie);
    const u = await getSessionUser(c.env.DB, idHash, now);
    if (u) {
      c.set('user', { id: u.id, handle: u.handle, role: u.role });
    } else {
      // Either unknown, expired or belongs to a removed user. Clean up the expired case; harmless otherwise.
      await deleteExpiredSession(c.env.DB, idHash, now);
    }
  }
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
