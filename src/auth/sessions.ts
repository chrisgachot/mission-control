/**
 * Browser sessions (Security track). Contract: docs/ARCHITECTURE.md §3 "Session".
 *
 * - The cookie `mc_session` carries 32 random bytes (base64url). That value is a bearer secret, so the
 *   database stores only sha256(value) as sessions.id: a read of the D1 database (backup, export,
 *   log) does not yield usable sessions.
 * - HttpOnly: page scripts (including any injected script) cannot read the cookie.
 * - Secure: only sent over HTTPS. Skipped on localhost / 127.0.0.1 so `wrangler dev` over plain http works.
 * - SameSite=Lax: cross-site subresource and POST requests do not carry it, which together with the
 *   X-Requested-With header check (middleware) is the CSRF defence.
 * - Path=/, Max-Age 30 days, with a matching server-side expires_at (the server value is the one enforced).
 * - A fresh random value on every login (no session fixation; the old cookie is just replaced).
 */
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../env.d.ts';
import { randomToken, sha256B64u } from '../crypto/index.ts';
import { insertSession, deleteSession } from './db.ts';

export const SESSION_COOKIE = 'mc_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** localhost and 127.0.0.1 only: the two hostnames `wrangler dev` and Playwright use. */
export function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export function requestHostname(c: Context<AppEnv>): string {
  return new URL(c.req.url).hostname;
}

function cookieOptions(c: Context<AppEnv>, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: !isLocalHostname(requestHostname(c)),
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** sessions.id for a cookie value. */
export function sessionIdFor(cookieValue: string): Promise<string> {
  return sha256B64u(cookieValue);
}

/**
 * Generate a cookie value and its hash. Used by registration, which inserts the session row inside the
 * same transaction as the user (see registerUser in db.ts); call setSessionCookie after it commits.
 */
export async function newSessionValue(now: number): Promise<{ value: string; idHash: string; expiresAt: number }> {
  const value = randomToken(32);
  return { value, idHash: await sessionIdFor(value), expiresAt: now + SESSION_TTL_MS };
}

export function setSessionCookie(c: Context<AppEnv>, value: string): void {
  setCookie(c, SESSION_COOKIE, value, cookieOptions(c, Math.floor(SESSION_TTL_MS / 1000)));
}

/** Create a session row for userId and set the cookie. */
export async function startSession(c: Context<AppEnv>, userId: string, now: number): Promise<void> {
  const s = await newSessionValue(now);
  await insertSession(c.env.DB, s.idHash, userId, now, s.expiresAt);
  setSessionCookie(c, s.value);
}

export function readSessionCookie(c: Context<AppEnv>): string | null {
  const v = getCookie(c, SESSION_COOKIE);
  // Our values are 43 base64url chars. Anything else cannot be a session; skip the DB round trip.
  if (!v || !/^[A-Za-z0-9_-]{43}$/.test(v)) return null;
  return v;
}

/** Delete the current session row (if any) and clear the cookie. */
export async function endSession(c: Context<AppEnv>): Promise<void> {
  const v = readSessionCookie(c);
  if (v) await deleteSession(c.env.DB, await sessionIdFor(v));
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: !isLocalHostname(requestHostname(c)), httpOnly: true, sameSite: 'Lax' });
}
