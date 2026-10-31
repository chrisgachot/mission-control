/**
 * Worker-to-Worker fetch for shared spaces (Security track; review 1, finding 6). Used by src/forward.ts,
 * src/api/board.ts (Connector track, minimal call-site changes) and src/api/remote-spaces.ts.
 *
 * - redirect: 'manual', and any 3xx is a failure. These requests carry a bearer member token and, on
 *   /ingest, encrypted content. Following a redirect could hand both to a host the owner never connected
 *   (a moved custom domain, a CDN rule). We do not rely on the runtime stripping Authorization.
 * - The response body is read as a stream with a BYTE cap (not a UTF-16 length check after reading it
 *   all), and a Content-Length over the cap is refused before reading. An oversized or endless response
 *   cannot exhaust the Worker's memory.
 * - Errors carry fixed messages starting with "shared space answered" or "unexpected response" (what
 *   board.ts's describeFailure shows to people). They never echo the response body: a JSON SyntaxError
 *   message would include an excerpt of it.
 */

/** Cap for small JSON responses: /api/remote/space, /api/remote/projects, /api/remote/ingest. Same as remote-spaces.ts. */
export const MAX_REMOTE_RESPONSE_BYTES = 64 * 1024;
/**
 * Cap for /api/remote/board. Deliberately larger than the 64 KiB above: a board slice carries every
 * workstream plus a range of updates, each with ~250-byte envelopes, so a modest 30-day board passes
 * 64 KiB (about 50 workstreams or 140 updates). 4 MiB still bounds memory per request.
 */
export const MAX_REMOTE_BOARD_BYTES = 4 * 1024 * 1024;

export interface RemoteResponse {
  status: number;
  ok: boolean;
  text: string;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error('unexpected response from shared space (too large)');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('unexpected response from shared space (too large)');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function fetchRemote(
  url: string,
  init: { method?: 'GET' | 'POST'; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number },
): Promise<RemoteResponse> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error(`shared space answered ${res.status} (redirect, not followed)`);
  }
  const text = await readCapped(res, init.maxBytes);
  return { status: res.status, ok: res.ok, text };
}

/** JSON.parse with a fixed error message (never echoes the body). */
export function parseRemoteJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('unexpected response from shared space (not JSON)');
  }
}
