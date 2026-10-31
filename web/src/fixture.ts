/**
 * Dev-only data for /?fixture=1: the mockup's 21 items, 6 projects and 5 tools, plus one tiny shared space,
 * run through the same bucketing the Worker uses. Deterministic. Never shipped to real users' data paths.
 */
import type { ActivityBucket, DerivedStatus, ProjectRow, Range, Status, Tool, UpdateKind } from '../../src/types.ts';
import { TOOLS } from '../../src/types.ts';
import { bucketActivity, rangeStart } from '../../src/status.ts';
import type { DecryptedBoard, DecryptedSlice, DecryptedUpdate, DecryptedWorkstream } from './vault-types.ts';

type S = 'needs' | 'running' | 'stale' | 'done';
interface Mock {
  id: number;
  t: string;
  tool: Tool;
  p: string;
  s: S;
  age: number; // hours
  next: string;
  log: string[];
}

const PROJECTS: Array<[string, string]> = [
  ['field', 'Field'],
  ['codex', 'Codex'],
  ['beacon', 'Beacon'],
  ['bf88', 'Black Falcon'],
  ['floor', 'Floorplan Repo'],
  ['personal', 'Personal'],
];

const ITEMS: Mock[] = [
  { id: 1, t: 'Approve UniFi U7 Pro purchase', tool: 'duet', p: 'bf88', s: 'needs', age: 1, next: 'Approve $214 spend in Link', log: ['Found best price at UI Store', 'Confirmed model with you', 'Link approval requested'] },
  { id: 2, t: 'Pick a session timeout for Field auth', tool: 'code', p: 'field', s: 'needs', age: 3, next: 'Choose 8h, 24h, or 7 days', log: ['Refactored token refresh', 'Tests passing', 'Paused for your decision'] },
  { id: 3, t: 'Review HY35 knowledge capture draft', tool: 'cowork', p: 'codex', s: 'needs', age: 20, next: 'Read and mark up the draft', log: ['Pulled interview notes', 'Drafted 14 sections', 'Draft ready for review'] },
  { id: 4, t: 'Collect vendor contacts from Light Hill Gmail', tool: 'duet', p: 'field', s: 'running', age: 0.5, next: 'Nothing yet, it will report back', log: ['Scanned 412 threads', 'Found 63 vendors', 'Matching to Field vendor list'] },
  { id: 5, t: 'Uptime function for Beacon', tool: 'code', p: 'beacon', s: 'running', age: 2, next: 'Watch the next deploy', log: ['Wrote Netlify Function', 'Deployed to preview', 'Monitoring 45 sites'] },
  { id: 6, t: 'Status wall layout v2', tool: 'cowork', p: 'beacon', s: 'running', age: 30, next: 'Pick between two layouts', log: ['Mocked two layouts', 'Added power tiles'] },
  { id: 7, t: 'Schedule interview with Paula', tool: 'duet', p: 'codex', s: 'running', age: 5, next: 'Waiting on Paula to reply', log: ['Proposed three times', 'Sent invite draft'] },
  { id: 8, t: 'Asset onboarding camera flow', tool: 'code', p: 'field', s: 'running', age: 6, next: 'Test on your phone', log: ['Added barcode scan', 'Wired photo upload to Blobs'] },
  { id: 9, t: 'UniFi Access door schedules', tool: 'chat', p: 'bf88', s: 'running', age: 26, next: 'Confirm warehouse hours', log: ['Drafted schedule by door', 'Flagged after hours rule'] },
  { id: 10, t: 'Cousy packaging quotes', tool: 'duet', p: 'personal', s: 'running', age: 8, next: 'Wait for two more quotes', log: ['Emailed four suppliers', 'One quote back'] },
  { id: 11, t: 'OCR date extraction tuning', tool: 'code', p: 'floor', s: 'running', age: 50, next: 'Spot check 20 results', log: ['Retrained on title blocks', 'Accuracy up to 91%'] },
  { id: 12, t: 'Cousy branding ideas', tool: 'chat', p: 'personal', s: 'stale', age: 288, next: 'Resume or archive', log: ['Brainstormed names', 'Sketched logo directions'] },
  { id: 13, t: 'Floorplan history slider', tool: 'code', p: 'floor', s: 'stale', age: 216, next: 'Resume or archive', log: ['Built slider UI', 'Stopped at date sorting bug'] },
  { id: 14, t: 'Codex interview question bank', tool: 'chat', p: 'codex', s: 'running', age: 40, next: 'Add equestrian questions', log: ['Wrote 40 questions', 'Grouped by system'] },
  { id: 15, t: 'Vendor lookup search', tool: 'code', p: 'field', s: 'done', age: 70, next: 'Shipped', log: ['Shipped to field.lighthillpm.com'] },
  { id: 16, t: 'Codex template', tool: 'cowork', p: 'codex', s: 'done', age: 96, next: 'Shipped', log: ['Template saved'] },
  { id: 17, t: 'Order patch panels', tool: 'duet', p: 'bf88', s: 'done', age: 52, next: 'Delivered Thursday', log: ['Approved in Link', 'Order confirmed'] },
  { id: 18, t: 'Beacon color legend', tool: 'chat', p: 'beacon', s: 'done', age: 120, next: 'Shipped', log: ['Legend finalized'] },
  { id: 19, t: 'UPS power tile', tool: 'code', p: 'beacon', s: 'done', age: 30, next: 'Shipped', log: ['Live on the wall'] },
  { id: 20, t: 'Morning inbox triage', tool: 'duet', p: 'personal', s: 'running', age: 0.2, next: "Read this morning's brief", log: ['Sorted 38 emails', '3 need replies'] },
  { id: 21, t: 'Field rollout email', tool: 'cowork', p: 'field', s: 'done', age: 140, next: 'Sent', log: ['Draft approved', 'Sent to staff'] },
  { id: 22, t: 'Summarize vendor contracts', tool: 'chatgpt', p: 'field', s: 'running', age: 4, next: 'Review the renewal dates it flagged', log: ['Read 12 contracts', 'Flagged three auto-renewals'] },
];

function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const H = 3_600_000;

function derive(s: S): { status: Status; derived: DerivedStatus } {
  if (s === 'needs') return { status: 'waiting', derived: 'waiting' };
  if (s === 'stale') return { status: 'running', derived: 'stale' };
  if (s === 'done') return { status: 'done', derived: 'done' };
  return { status: 'running', derived: 'running' };
}

function project(id: string, name: string, order: number): ProjectRow {
  return { id, name, remoteSpaceId: null, remoteProjectId: null, sortOrder: order, createdAt: 0, archivedAt: null };
}

interface Built {
  slice: DecryptedSlice;
  allUpdates: Array<DecryptedUpdate & { tool: Tool }>;
}

function build(now: number, spaceId: string | null, spaceName: string, projects: ProjectRow[], items: Mock[], seed: number): Built {
  const r = rng(seed);
  const workstreams: DecryptedWorkstream[] = [];
  const all: Array<DecryptedUpdate & { tool: Tool }> = [];
  let uid = 0;
  const mockOf = new Map<string, Mock>();
  const mk = (wsId: string, tool: Tool, kind: UpdateKind, body: string, at: number): DecryptedUpdate & { tool: Tool } => ({
    id: `${spaceId ?? 'l'}-u${uid++}`,
    workstreamId: wsId,
    kind,
    actor: 'agent',
    body,
    keyId: 'fixture',
    createdAt: at,
    tool,
  });
  for (const it of items) {
    const wsId = `${spaceId ?? 'l'}-w${it.id}`;
    mockOf.set(wsId, it);
    const last = now - it.age * H;
    const kindNow: UpdateKind = it.s === 'needs' ? 'waiting' : it.s === 'done' ? 'done' : 'milestone';
    const ups = [mk(wsId, it.tool, kindNow, it.next, last)];
    [...it.log].reverse().forEach((l, k) => {
      ups.push(mk(wsId, it.tool, k === it.log.length - 1 ? 'started' : 'milestone', l, last - (k + 1) * (3 + k * 5) * H));
    });
    all.push(...ups);
    const d = derive(it.s);
    workstreams.push({
      id: wsId,
      projectId: it.p,
      tool: it.tool,
      status: d.status,
      derived: d.derived,
      title: it.t,
      link: it.id % 3 === 0 ? null : 'https://example.com/session/' + it.id,
      externalId: null,
      keyId: 'fixture',
      originUserId: null,
      createdAt: last - 48 * H,
      updatedAt: last,
      lastAgentAt: last,
      snoozedUntil: null,
      doneAt: it.s === 'done' ? last : null,
      archivedAt: null,
      latestUpdate: ups[0] as DecryptedUpdate,
      remoteSpaceId: spaceId,
    });
  }
  // Background chatter so the 30-day chart has a believable shape: weekdays busier, nights quiet.
  const base: Record<Tool, number> = { code: 9, cowork: 5, duet: 7, chat: 4, chatgpt: 3 };
  for (let hrs = 30 * 24; hrs > 0; hrs--) {
    const t = now - hrs * H + r() * H;
    const d = new Date(t);
    const wk = d.getDay() === 0 || d.getDay() === 6 ? 0.45 : 1;
    const hr = d.getHours() >= 8 && d.getHours() <= 19 ? 1 : 0.2;
    for (const tool of TOOLS) {
      const pool = workstreams.filter((w) => w.tool === tool);
      if (!pool.length) continue;
      const lambda = ((base[tool] * (0.6 + r())) / 12) * wk * hr;
      const n = Math.floor(lambda) + (r() < lambda % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const w = pool[Math.floor(r() * pool.length)] as DecryptedWorkstream;
        const it = mockOf.get(w.id) as Mock;
        const text = it.log[Math.floor(r() * it.log.length)] as string;
        all.push(mk(w.id, tool, 'milestone', text, t));
      }
    }
  }
  return {
    slice: { spaceId, spaceName, projects, workstreams, updates: [], activity: [], keyIds: ['fixture'] },
    allUpdates: all,
  };
}

export function fixtureBoard(range: Range, now = Date.now()): DecryptedBoard {
  const since = rangeStart(range, now);
  const local = build(now, null, 'Chris', PROJECTS.map(([id, n], i) => project(id, n, i)), ITEMS, 11);
  const shared = build(
    now,
    'light-hill',
    'Light Hill',
    [project('lh-ops', 'Light Hill Ops', 0)],
    [
      { id: 1, t: 'Approve Q4 vendor renewals', tool: 'cowork', p: 'lh-ops', s: 'needs', age: 6, next: 'Sign off on three renewals', log: ['Collected renewal quotes', 'Compared against last year'] },
      { id: 2, t: 'Draft board packet', tool: 'chatgpt', p: 'lh-ops', s: 'running', age: 3, next: 'Section 4 is next', log: ['Outlined sections', 'Pulled budget table'] },
    ],
    29,
  );
  const finish = (b: Built): DecryptedSlice => {
    const inRange = b.allUpdates.filter((u) => u.createdAt >= since && u.createdAt <= now);
    const activity: ActivityBucket[] = bucketActivity(range, now, inRange.map((u) => ({ tool: u.tool, at: u.createdAt })));
    return {
      ...b.slice,
      updates: inRange.map(({ tool: _t, ...u }) => u).sort((a, c) => c.createdAt - a.createdAt),
      activity,
    };
  };
  return {
    now,
    range,
    space: { name: 'Chris', kind: 'personal', setupComplete: true, publicKey: null, keyId: null, version: 'fixture' },
    local: finish(local),
    remote: [finish(shared)],
  };
}
