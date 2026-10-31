/**
 * Small HTTP helpers shared by the Security track's routers (auth, keys, invites, members, remote-spaces).
 * JSON errors are always `{ error: { code, message } }` (docs/ARCHITECTURE.md §1). Messages are written
 * for people and never echo secrets, key material or raw validation internals.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import type { WrappedKey } from '../types.ts';
import { isCryptoError, validateWrappedKey } from '../crypto/index.ts';

export function fail(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** Parse and validate a JSON body. Returns the data, or a ready-made 400 response. */
export async function parseBody<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: fail(c, 400, 'bad_request', 'Body must be JSON.') };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    // Report which fields failed, not their values.
    const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(body)'))].slice(0, 5).join(', ');
    return { ok: false, res: fail(c, 400, 'bad_request', `Invalid request body: ${fields}.`) };
  }
  return { ok: true, data: r.data };
}

/** Structured log line. Callers pass only ids and event names, never plaintext or key material. */
export function logEvent(c: Context<AppEnv>, event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  console.log(JSON.stringify({ requestId: c.get('requestId'), event, ...fields }));
}

/**
 * zod schema for a WrappedKey: zod checks it is an object, then the crypto module's validator checks
 * version, kind, kid charset and exact byte lengths (and drops unknown fields).
 */
export const wrappedKeySchema = z.unknown().transform((v, ctx): WrappedKey => {
  try {
    return validateWrappedKey(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: isCryptoError(e) ? e.code : 'invalid_wrapped_key' });
    return z.NEVER;
  }
});

export const handleSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // No control / format characters (no RTL overrides, zero-width tricks, newlines in names).
  .regex(/^[^\p{C}]+$/u);

/** WebAuthn ids are base64url; 1023 bytes is the spec maximum for a credential id. */
export const credentialIdSchema = z.string().min(1).max(1400).regex(/^[A-Za-z0-9_-]+$/);

export function spaceName(c: Context<AppEnv>, metaName: string | null): string {
  return metaName ?? c.env.SPACE_NAME;
}
