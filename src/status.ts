/**
 * Status derivation and activity bucketing (docs/ARCHITECTURE.md section 2).
 * Pure functions: no I/O, no clock reads (callers pass `now`).
 */
import { STALE_AFTER_MS, TOOLS } from './types.ts';
import type { ActivityBucket, DerivedStatus, Range, Status, Tool } from './types.ts';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function deriveStatus(
  ws: { status: Status; lastAgentAt: number; snoozedUntil: number | null },
  now: number,
): DerivedStatus {
  if (ws.status === 'done') return 'done';
  if (ws.status === 'archived') return 'archived';
  const cold = now - ws.lastAgentAt >= STALE_AFTER_MS;
  const snoozed = ws.snoozedUntil != null && ws.snoozedUntil > now;
  if (cold && !snoozed) return 'stale';
  return ws.status;
}

export const RANGE_MS: Record<Range, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

const BUCKETS: Record<Range, { count: number; sizeMs: number }> = {
  '24h': { count: 24, sizeMs: HOUR_MS },
  '7d': { count: 7, sizeMs: DAY_MS },
  '30d': { count: 30, sizeMs: DAY_MS },
};

export function isRange(v: unknown): v is Range {
  return v === '24h' || v === '7d' || v === '30d';
}

/** Start of the window ending at `now`. */
export function rangeStart(range: Range, now: number): number {
  return now - RANGE_MS[range];
}

function emptyCounts(): Record<Tool, number> {
  const counts = {} as Record<Tool, number>;
  for (const t of TOOLS) counts[t] = 0;
  return counts;
}

/**
 * Buckets agent updates per tool. Windows are aligned to `now` (the last bucket ends at `now`),
 * so the result does not depend on the viewer's time zone. 24h = 24 hourly, 7d = 7 daily, 30d = 30 daily.
 */
export function bucketActivity(
  range: Range,
  now: number,
  events: ReadonlyArray<{ tool: Tool; at: number }>,
): ActivityBucket[] {
  const { count, sizeMs } = BUCKETS[range];
  const start = now - count * sizeMs;
  const buckets: ActivityBucket[] = [];
  for (let i = 0; i < count; i++) {
    buckets.push({ start: start + i * sizeMs, end: start + (i + 1) * sizeMs, counts: emptyCounts() });
  }
  for (const ev of events) {
    if (ev.at < start || ev.at > now) continue;
    const idx = Math.min(count - 1, Math.floor((ev.at - start) / sizeMs));
    const bucket = buckets[idx];
    if (bucket && ev.tool in bucket.counts) bucket.counts[ev.tool] += 1;
  }
  return buckets;
}
