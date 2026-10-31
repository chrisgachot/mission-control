import { $, $$, esc, ago } from '../util.ts';
import { model, store } from '../store.ts';
import { sortItems, STALE_DAYS } from '../model.ts';
import { STATUS_UI, TOOL_ORDER, TOOL_UI } from '../tools.ts';
import { hideTip, showTip } from './tooltip.ts';
import { openItem, openList, openTool } from './views.ts';

export function renderDecay(): void {
  const m = model();
  const svg = $<SVGSVGElement>('#decay');
  const W = 620;
  const H = 320;
  const L = 104;
  const R = 16;
  const T = 10;
  const Bm = 34;
  const iw = W - L - R;
  const ih = H - T - Bm;
  const maxD = 14;
  const lane = ih / TOOL_ORDER.length;
  const x = (d: number) => L + Math.sqrt(Math.min(d, maxD) / maxD) * iw;
  const open = m.items.filter((i) => i.status !== 'done');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute(
    'aria-label',
    `Strip plot of ${open.length} open workstreams by days since last activity. ${open.filter((i) => i.status === 'stale').length} are past ${STALE_DAYS} days.`,
  );
  let o = `<rect x="${x(STALE_DAYS)}" y="${T}" width="${x(maxD) - x(STALE_DAYS)}" height="${ih}" fill="rgba(255,69,58,.06)"/><line x1="${x(STALE_DAYS)}" x2="${x(STALE_DAYS)}" y1="${T}" y2="${T + ih}" stroke="rgba(255,69,58,.45)" stroke-dasharray="3 4"/><text x="${x(STALE_DAYS) + 8}" y="${T + 14}" style="font:600 10.5px var(--mono);letter-spacing:.14em;fill:#ff6961">GOING COLD</text>`;
  [0, 1, 2, 4, 7, 10, 14].forEach((d) => (o += `<g class="axis"><text x="${x(d)}" y="${H - 12}" text-anchor="middle">${d === maxD ? '14d+' : d + 'd'}</text></g>`));
  TOOL_ORDER.forEach((k, ri) => {
    const cy = T + lane * ri + lane / 2;
    const f = store.tool && store.tool !== k;
    o += `<line x1="${L}" x2="${W - R}" y1="${cy}" y2="${cy}" class="gridline"/><text x="${L - 12}" y="${cy + 4}" text-anchor="end" tabindex="0" role="button" style="font-size:12px;fill:${f ? 'var(--ink3)' : 'var(--ink2)'};cursor:pointer" data-tool="${k}">${esc(TOOL_UI[k].name)}</text>`;
    const its = open.filter((i) => i.tool === k).sort((a, b) => a.ageMs - b.ageMs);
    its.forEach((it, j) => {
      const d = it.ageMs / 86_400_000;
      const cx = x(d);
      const off = ((j % 3) - 1) * 9;
      const c = TOOL_UI[k].color;
      const stale = it.status === 'stale';
      o += `<g class="dotg" data-item="${esc(it.key)}" tabindex="${f ? -1 : 0}" role="button" aria-label="${esc(it.title)}, ${ago(it.ageMs)}" style="cursor:pointer;opacity:${f ? 0.12 : 1}"><circle cx="${cx}" cy="${cy + off}" r="14" fill="transparent"/><circle cx="${cx}" cy="${cy + off}" r="${it.status === 'needs' ? 7 : 5.5}" fill="${stale ? 'transparent' : c}" stroke="${stale ? c : '#06070c'}" stroke-width="2" ${stale ? '' : `style="filter:drop-shadow(0 0 5px ${c})"`}/>${it.status === 'needs' ? `<circle cx="${cx}" cy="${cy + off}" r="10.5" fill="none" stroke="#ff9f0a" stroke-width="1.5"/>` : ''}</g>`;
    });
  });
  if (!open.length) o += `<text x="${L + iw / 2}" y="${T + ih / 2}" text-anchor="middle" class="endlabel" style="fill:var(--ink3)">Nothing open, so nothing is going cold</text>`;
  svg.innerHTML = o;
  $$<SVGElement>('.dotg', svg).forEach((g) => {
    const it = m.itemByKey.get(g.dataset.item as string);
    if (!it) return;
    g.onmousemove = (e) =>
      showTip(
        `<div class="t">${esc(it.title)}</div><div class="r"><i style="background:${TOOL_UI[it.tool].color}"></i>${esc(TOOL_UI[it.tool].name)}<b>${ago(it.ageMs)}</b></div><div class="r">${esc(STATUS_UI[it.status].name)}<b>${esc(m.projectByKey.get(it.projectKey)?.name ?? '')}</b></div><div class="k">Click for details</div>`,
        e,
      );
    g.onmouseleave = hideTip;
    const go = () => {
      hideTip();
      openItem(it.key);
    };
    g.onclick = go;
    g.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    };
  });
  $$<SVGElement>('[data-tool]', svg).forEach((t) => {
    const go = () => openTool(t.dataset.tool as (typeof TOOL_ORDER)[number]);
    t.onclick = go;
    t.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    };
  });
}

export function wireStaleAll(): void {
  $('#staleAll').onclick = () =>
    openList(
      'Going cold',
      `Untouched for ${STALE_DAYS} days or more. Resume or archive each one.`,
      () => model().items.filter((i) => i.status === 'stale' && (!store.tool || i.tool === store.tool)).sort(sortItems),
      'Nothing is going cold.',
    );
}
