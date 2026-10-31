/** Small response and parsing helpers shared by the Connector track routers. */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import type { AppEnv } from '../env.d.ts';

export function apiError(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

export async function readJson<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<Parsed<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: apiError(c, 400, 'bad_request', 'Body must be JSON.') };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? first.path.join('.') + ': ' : '';
    return { ok: false, res: apiError(c, 400, 'bad_request', where + (first ? first.message : 'Invalid body.')) };
  }
  return { ok: true, data: parsed.data };
}

/** waitUntil that tolerates contexts without an ExecutionContext (unit tests). */
export function waitUntilOf(c: Context<AppEnv>): (p: Promise<unknown>) => void {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return (p) => {
      p.catch(() => undefined);
    };
  }
}
