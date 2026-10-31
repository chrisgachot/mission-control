import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('GET /api/health', () => {
  it('returns 200 with ok: true', async () => {
    const res = await SELF.fetch('https://mission-control.test/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
