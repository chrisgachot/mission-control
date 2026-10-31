import { DAY, $, $$, esc, plural } from '../util.ts';
import { model, store, hooks } from '../store.ts';
import { sortItems } from '../model.ts';
import type { Item } from '../model.ts';
import { STATUS_UI, TOOL_ORDER, TOOL_UI } from '../tools.ts';
import type { UiStatus } from '../tools.ts';
import { greetingWord } from '../util.ts';
import { openList } from './views.ts';

export const visible = (): Item[] => model().items.filter((i) => !store.tool || i.tool === store.tool);
export const doneThisWeek = (i: Item): boolean => i.status === 'done' && model().now - i.lastAt <= 7 * DAY;
export const byStatus = (s: UiStatus): Item[] => visible().filter((i) => (s === 'done' ? doneThisWeek(i) : i.status === s));

export function renderGreeting(): void {
  const v = visible();
  const n = v.filter((i) => i.status === 'needs').length;
  const r = v.filter((i) => i.status === 'running').length + n + v.filter((i) => i.status === 'stale').length;
  const who = store.handle ? `, ${esc(store.handle)}` : '';
  const where = store.tool ? ` in ${esc(TOOL_UI[store.tool].name)}` : '';
  let text: string;
  if (!model().items.length) text = `${greetingWord()}${who}. Nothing has reported in yet. Connect an agent from Setup and it will show up here.`;
  else if (!v.length) text = `${greetingWord()}${who}. Nothing is open${where}.`;
  else
    text = `${greetingWord()}${who}. <b>${r} ${plural(r, 'workstream')}</b> ${r === 1 ? 'is' : 'are'} open and <b>${n}</b> ${n === 1 ? 'is' : 'are'} waiting on you${where}.`;
  $('#greeting').innerHTML = text;
}

function ringSVG(frac: number, color: string): string {
  const R = 17;
  const C = 2 * Math.PI * R;
  return `<svg class="ring" viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="4"/><circle cx="21" cy="21" r="${R}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C * frac} ${C}" transform="rotate(-90 21 21)" style="filter:drop-shadow(0 0 4px ${color})"/></svg>`;
}

export function renderHud(): void {
  const total = visible().filter((i) => i.status !== 'done' || doneThisWeek(i)).length || 1;
  const defs: Array<[UiStatus, string, string]> = [
    ['running', 'Running', '#5ef2ff'],
    ['needs', 'Waiting on you', '#ff9f0a'],
    ['stale', 'Stale, 7+ days', '#ff453a'],
    ['done', 'Done this week', '#30d158'],
  ];
  const hud = $('#hud');
  hud.innerHTML = defs
    .map(([s, label, c]) => {
      const n = byStatus(s).length;
      return `<button class="readout" data-s="${s}" aria-label="${n} ${esc(label)}. Open the list.">${ringSVG(n / total, c)}<div><div class="val">${n}</div><div class="lab">${STATUS_UI[s].icon.replace('<svg', `<svg width="11" height="11" style="color:${c}"`)}${esc(label)}</div></div><span class="chev" aria-hidden="true">›</span></button>`;
    })
    .join('');
  $$<HTMLElement>('.readout', hud).forEach((b) => {
    b.onclick = () => {
      const s = b.dataset.s as UiStatus;
      const label = defs.find((d) => d[0] === s)?.[1] ?? '';
      openList(label, `${store.tool ? TOOL_UI[store.tool].name + ' only · ' : ''}tap any row for details`, () => byStatus(s).slice());
    };
  });
}

export function renderLegends(): void {
  for (const sel of ['#legendA', '#legendB']) {
    const el = $(sel);
    el.innerHTML =
      TOOL_ORDER.map(
        (k) =>
          `<button class="chip ${store.tool === k ? 'on' : store.tool ? 'dim' : ''}" data-k="${k}" aria-pressed="${store.tool === k}"><i style="background:${TOOL_UI[k].color};box-shadow:0 0 8px ${TOOL_UI[k].color}"></i>${esc(TOOL_UI[k].name)}</button>`,
      ).join('') + (store.tool ? `<button class="chip" data-k="">Show all</button>` : '');
    $$<HTMLElement>('.chip', el).forEach((c) => {
      c.onclick = () => hooks.setTool((c.dataset.k || null) as typeof store.tool);
    });
  }
}

export const sortedNeeds = (): Item[] => byStatus('needs').sort(sortItems);
