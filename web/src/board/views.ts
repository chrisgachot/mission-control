/** Sheet views: item, project, tool, list and activity-bucket. Each reads live state so refreshes just work. */
import type { PersonAction, Tool } from '../../../src/types.ts';
import { api } from '../api.ts';
import { ago, esc, errMessage, plural } from '../util.ts';
import { vault } from '../vault.ts';
import type { DecryptedUpdate } from '../vault-types.ts';
import { model, store, hooks } from '../store.ts';
import { sortItems, isOpen } from '../model.ts';
import type { Bucket, Item } from '../model.ts';
import { TOOL_ORDER, TOOL_UI } from '../tools.ts';
import { openSheet, refreshSheet, closeSheet } from './sheet.ts';
import type { SheetView, ViewFn } from './sheet.ts';
import { toast } from './toast.ts';
import { badge, sharedTag, sparkPath, toolGlyph } from './ui.ts';

// ---------- shared pieces ----------

export function itemRows(list: Item[], empty = 'Nothing here right now.'): string {
  if (!list.length) return `<div class="empty">${esc(empty)}</div>`;
  const m = model();
  return `<div class="list">${list
    .map(
      (i) =>
        `<button class="row" data-item="${esc(i.key)}">${toolGlyph(i.tool)}<div class="rtext"><div class="rtitle">${esc(i.title)}</div><div class="rsub">${badge(i.status)}<span>${esc(m.projectByKey.get(i.projectKey)?.name ?? '')}</span>${sharedTag(i.sharedName)}<span class="m">${ago(i.ageMs)}</span></div></div><span class="chev">›</span></button>`,
    )
    .join('')}</div>`;
}

/** Wire `[data-item]` rows inside a sheet body (push = drill in), or inside the board (push = false). */
export function wireItemRows(root: HTMLElement, push = true): void {
  root.querySelectorAll<HTMLElement>('[data-item]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openItem(b.dataset.item as string, push);
    };
  });
}

export const openItem = (key: string, push = false) => openSheet(() => itemView(key), push);
export const openProject = (key: string, push = false) => openSheet(() => projectView(key), push);
export const openTool = (tool: Tool, push = false) => openSheet(() => toolView(tool), push);
export const openList = (title: string, sub: string, pick: () => Item[], empty?: string) => openSheet(listView(title, sub, pick, empty), false);

export function listView(title: string, sub: string, pick: () => Item[], empty?: string): ViewFn {
  return () => ({
    title,
    sub: esc(sub),
    body: itemRows(pick().sort(sortItems), empty),
    after: (b) => wireItemRows(b),
  });
}

// ---------- item ----------

const TIMELINE_CAP = 8;
const expanded = new Set<string>();
const detailCache = new Map<string, { stamp: number; updates: DecryptedUpdate[] }>();
const loading = new Set<string>();

async function loadDetail(item: Item): Promise<void> {
  if (store.fixture || item.readOnly) return;
  const cached = detailCache.get(item.key);
  if (cached && cached.stamp === item.ws.updatedAt) return;
  if (loading.has(item.key)) return;
  loading.add(item.key);
  try {
    const d = await api.workstream(item.id);
    const updates: DecryptedUpdate[] = [];
    for (const u of d.updates) {
      const { bodyEnc, ...rest } = u;
      updates.push({ ...rest, body: await vault.decrypt(bodyEnc) });
    }
    updates.sort((a, b) => b.createdAt - a.createdAt);
    detailCache.set(item.key, { stamp: item.ws.updatedAt, updates });
    refreshSheet();
  } catch {
    // The board already carried recent updates; the full timeline is a bonus.
  } finally {
    loading.delete(item.key);
  }
}

const KIND_LABEL: Record<string, string> = {
  started: 'Started',
  milestone: 'Progress',
  waiting: 'Waiting on you',
  done: 'Finished',
  action: 'You',
};

function safeUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const ACTION_TOAST: Record<PersonAction, string> = {
  handled: 'Marked handled',
  snooze: 'Snoozed until tomorrow',
  archive: 'Archived',
  resume: 'Back in motion',
  reopen: 'Reopened',
};

export async function runAction(item: Item, action: PersonAction): Promise<void> {
  if (store.fixture) {
    toast('Fixture mode: nothing is saved');
    return;
  }
  try {
    await api.action(item.id, action);
    toast(ACTION_TOAST[action]);
    detailCache.delete(item.key);
    await hooks.refresh();
  } catch (e) {
    toast(errMessage(e));
  }
}

export function openExternal(item: Item): void {
  const url = safeUrl(item.link);
  if (!url) {
    toast('No link was reported for this one');
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function itemView(key: string): SheetView | null {
  const m = model();
  const i = m.itemByKey.get(key);
  if (!i) return null;
  const proj = m.projectByKey.get(i.projectKey);
  const ups = detailCache.get(key)?.updates ?? i.updates;
  const label = i.status === 'needs' ? 'Needs from you' : i.status === 'done' ? 'Result' : 'Latest';
  const acts: string[] = [];
  acts.push(`<button class="btn primary" data-a="open">${esc(TOOL_UI[i.tool].open)}</button>`);
  if (!i.readOnly) {
    if (i.status === 'done') acts.push(`<button class="btn" data-a="reopen">Reopen</button>`);
    else {
      if (i.status === 'needs') acts.push(`<button class="btn" data-a="handled">Mark handled</button>`);
      if (i.status === 'stale') acts.push(`<button class="btn" data-a="resume">Resume</button>`);
      if (i.status !== 'stale') acts.push(`<button class="btn" data-a="snooze">Snooze a day</button>`);
    }
    acts.push(`<button class="btn destructive" data-a="archive">Archive</button>`);
  }
  const shown = expanded.has(key) ? ups : ups.slice(0, TIMELINE_CAP);
  const timeline = ups.length
    ? `<div class="timeline">${shown
        .map(
          (u) =>
            `<div class="tl${u.actor === 'person' ? ' you' : ''}"><div>${esc(u.body || KIND_LABEL[u.kind] || u.kind)}</div><div class="when">${esc(KIND_LABEL[u.kind] ?? u.kind)} \u00b7 ${ago(Math.max(0, m.now - u.createdAt))}</div></div>`,
        )
        .join('')}</div>${ups.length > shown.length ? `<button class="textbtn" data-more>Show ${ups.length - shown.length} older</button>` : ''}`
    : `<div class="empty small">No updates in this window.</div>`;
  return {
    title: i.title,
    sub: `${badge(i.status)} &nbsp;${esc(TOOL_UI[i.tool].name)} · last activity ${ago(i.ageMs)}${i.snoozed ? ' · snoozed' : ''}`,
    body: `<dl class="kv"><dt>Project</dt><dd><button data-proj="${esc(i.projectKey)}">${esc(proj?.name ?? 'Unknown')}</button> ${sharedTag(i.sharedName)}</dd>
      <dt>Running in</dt><dd><button data-tool="${i.tool}">${esc(TOOL_UI[i.tool].name)}</button></dd>
      ${i.next ? `<dt>${label}</dt><dd>${esc(i.next)}</dd>` : ''}</dl>
      ${i.readOnly ? `<div class="note">This one lives in the shared space ${esc(i.sharedName ?? '')}. Handle it there.</div>` : ''}
      <div class="actions" style="margin-top:4px">${acts.join('')}</div>
      <div class="sect">Timeline</div>${timeline}`,
    after(b) {
      b.querySelectorAll<HTMLElement>('[data-proj]').forEach((x) => (x.onclick = () => openProject(x.dataset.proj as string, true)));
      b.querySelectorAll<HTMLElement>('[data-tool]').forEach((x) => (x.onclick = () => openTool(x.dataset.tool as Tool, true)));
      b.querySelectorAll<HTMLElement>('[data-a]').forEach(
        (x) =>
          (x.onclick = () => {
            const a = x.dataset.a as string;
            if (a === 'open') openExternal(i);
            else void runAction(i, a as PersonAction);
          }),
      );
      const more = b.querySelector<HTMLElement>('[data-more]');
      if (more)
        more.onclick = () => {
          expanded.add(key);
          refreshSheet();
        };
      void loadDetail(i);
    },
  };
}

// ---------- project ----------

function projectView(key: string): SheetView | null {
  const m = model();
  const p = m.projectByKey.get(key);
  if (!p) return null;
  const list = m.items.filter((i) => i.projectKey === key);
  const open = list.filter(isOpen);
  const toolsUsed = new Set(open.map((i) => i.tool)).size;
  const v = m.pulse.get(key) ?? new Array<number>(30).fill(0);
  const d = sparkPath(v, 560, 110, 6);
  const total = v.reduce((a, b) => a + b, 0);
  const done = list.filter((i) => i.status === 'done').sort((a, b) => a.ageMs - b.ageMs).slice(0, 12);
  return {
    title: p.name,
    sub: `${open.length} open across ${toolsUsed} ${plural(toolsUsed, 'tool')}${p.sharedName ? ' · ' + sharedTag(p.sharedName) : ''}`,
    body: `<svg viewBox="0 0 560 120" style="width:100%;height:auto;margin:4px 0 6px" role="img" aria-label="${total} agent updates in the last 30 days"><defs><linearGradient id="pg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#5ef2ff" stop-opacity=".3"/><stop offset="1" stop-color="#5ef2ff" stop-opacity="0"/></linearGradient></defs>
      <path d="${d}L554 110L6 110Z" fill="url(#pg)"/><path d="${d}" fill="none" stroke="#5ef2ff" stroke-width="2" style="filter:drop-shadow(0 0 5px #5ef2ff)"/><text x="6" y="14" style="font:11px var(--mono);fill:var(--ink3)">LAST 30 DAYS OF ACTIVITY · ${total} UPDATES</text></svg>
      <div class="sect">Open</div>${itemRows(open.sort(sortItems), 'No open work in this project.')}
      <div class="sect">Done recently</div>${itemRows(done, 'Nothing finished yet.')}`,
    after: (b) => wireItemRows(b),
  };
}

// ---------- tool ----------

function toolView(k: Tool): SheetView {
  const m = model();
  const list = m.items.filter((i) => i.tool === k);
  const open = list.filter(isOpen);
  return {
    title: TOOL_UI[k].name,
    sub: `${open.length} open ${plural(open.length, 'workstream')}`,
    body: `<div class="actions" style="margin:0 0 6px"><button class="btn" id="filterTool">${store.tool === k ? 'Clear filter' : 'Filter the whole board to ' + esc(TOOL_UI[k].name)}</button></div>
      <div class="sect">Open</div>${itemRows(open.sort(sortItems), 'Nothing open in this tool.')}<div class="sect">Done</div>${itemRows(
        list.filter((i) => i.status === 'done').sort(sortItems),
        'Nothing finished yet.',
      )}`,
    after(b) {
      wireItemRows(b);
      (b.querySelector('#filterTool') as HTMLElement).onclick = () => {
        hooks.setTool(store.tool === k ? null : k);
        closeSheet();
      };
    },
  };
}

// ---------- activity bucket ----------

export function bucketTitle(b: Bucket): string {
  const d = new Date(b.end - 1);
  if (model().range === '24h') {
    const t = (n: number) => new Date(n).toLocaleTimeString('en-US', { hour: 'numeric' });
    return `${t(b.start)} \u2013 ${t(b.end)}`;
  }
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export function openBucket(index: number): void {
  openSheet(() => {
    const m = model();
    const b = m.buckets[index];
    if (!b) return null;
    const tools = TOOL_ORDER.filter((k) => !store.tool || k === store.tool);
    const count = tools.reduce((a, k) => a + b.counts[k], 0);
    const ev = b.events.filter((e) => {
      const it = m.itemByKey.get(e.itemKey);
      return it && (!store.tool || it.tool === store.tool);
    });
    const body = ev.length
      ? `<div class="list">${ev
          .slice(0, 60)
          .map((e) => {
            const it = m.itemByKey.get(e.itemKey) as Item;
            return `<button class="row" data-item="${esc(it.key)}">${toolGlyph(it.tool)}<div class="rtext"><div class="rtitle">${esc(e.text)}</div><div class="rsub"><span>${esc(it.title)}</span><span class="m">${esc(m.projectByKey.get(it.projectKey)?.name ?? '')}</span>${sharedTag(it.sharedName)}</div></div><span class="chev">›</span></button>`;
          })
          .join('')}</div>`
      : `<div class="empty">${count ? 'The details for these updates are older than this view carries.' : 'No agent activity in this window.'}</div>`;
    return {
      title: bucketTitle(b),
      sub: esc(`${count} agent ${plural(count, 'action')}${store.tool ? ' in ' + TOOL_UI[store.tool].name : ''}`),
      body,
      after: (el) => wireItemRows(el),
    };
  }, false);
}

