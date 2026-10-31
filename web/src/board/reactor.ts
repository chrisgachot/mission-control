import { $, $$, esc, ago, truncate } from '../util.ts';
import { model, store } from '../store.ts';
import { sortItems } from '../model.ts';
import { STATUS_UI, TOOL_ORDER, TOOL_UI } from '../tools.ts';
import { hideTip, showTip } from './tooltip.ts';
import { byStatus } from './hud.ts';
import { openItem, openList, openProject } from './views.ts';
import { itemLabel } from './ui.ts';

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function renderReactor(): void {
  const m = model();
  const svg = $<SVGSVGElement>('#reactor');
  const cx = 260;
  const cy = 260;
  const projects = m.projects;
  const sec = 360 / Math.max(projects.length, 1);
  const ringR = (ri: number) => 106 + ri * 31;
  const outer = ringR(TOOL_ORDER.length - 1) + 12;
  let out = `<defs>
    <radialGradient id="coreG"><stop offset="0" stop-color="rgba(94,242,255,.18)"/><stop offset="1" stop-color="rgba(94,242,255,0)"/></radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  if (projects.length > 1) {
    projects.forEach((_, pi) => {
      const [x, y] = polar(cx, cy, outer, pi * sec);
      out += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(255,255,255,.04)"/>`;
    });
  }
  const live = m.items.filter((i) => i.status !== 'done');
  TOOL_ORDER.forEach((k, ri) => {
    const r = ringR(ri);
    if (!projects.length) out += `<circle class="track" cx="${cx}" cy="${cy}" r="${r}" stroke-width="22"/>`;
    projects.forEach((p, pi) => {
      const pad = projects.length > 1 ? 3 : 0.5;
      const a0 = pi * sec + pad;
      const a1 = (pi + 1) * sec - pad;
      out += `<path class="track" d="${arcPath(cx, cy, r, a0, a1 - (projects.length === 1 ? 0.01 : 0))}" stroke-width="22"/>`;
      const its = live.filter((i) => i.tool === k && i.projectKey === p.key).sort(sortItems);
      if (!its.length) return;
      const gap = Math.min(2, (a1 - a0) / its.length / 3);
      const span = (a1 - a0 - (its.length - 1) * gap) / its.length;
      its.forEach((it, j) => {
        const s0 = a0 + j * (span + gap);
        const s1 = s0 + span - (projects.length === 1 && its.length === 1 ? 0.01 : 0);
        const faded = store.tool && store.tool !== k;
        const col = TOOL_UI[k].color;
        const dash = it.status === 'stale' ? 'stroke-dasharray="3 4" opacity=".55"' : '';
        out += `<path class="arc ${faded ? 'faded' : ''}" data-item="${esc(it.key)}" tabindex="${faded ? -1 : 0}" role="button" aria-label="${esc(itemLabel(it))}" d="${arcPath(cx, cy, r, s0, s1)}" fill="none" stroke="${col}" stroke-width="20" ${dash} ${it.status === 'stale' ? '' : 'filter="url(#glow)"'}/>`;
        if (it.status === 'needs' && !faded) {
          const [x, y] = polar(cx, cy, r + 15, (s0 + s1) / 2);
          out += `<circle class="pulse" cx="${x}" cy="${y}" r="5" fill="#ff9f0a" pointer-events="none"/><circle cx="${x}" cy="${y}" r="4.5" fill="#ff9f0a" stroke="#06070c" stroke-width="2" pointer-events="none"/>`;
        }
      });
    });
  });
  projects.forEach((p, pi) => {
    const mid = (pi + 0.5) * sec;
    const [x, y] = polar(cx, cy, outer + 14, mid);
    const anchor = Math.abs(x - cx) < 20 ? 'middle' : x > cx ? 'start' : 'end';
    out += `<text class="plabel" data-proj="${esc(p.key)}" tabindex="0" role="button" x="${x}" y="${y + 4}" text-anchor="${anchor}"><title>${esc(p.name)}${p.sharedName ? ' (shared · ' + esc(p.sharedName) + ')' : ''}</title>${esc(truncate(p.name, 18))}${p.sharedName ? ' ●' : ''}</text>`;
  });
  const n = byStatus('needs').length;
  out += `<g class="core" id="core" tabindex="0" role="button" aria-label="${n} waiting on you. Open the list."><circle cx="${cx}" cy="${cy}" r="92" fill="url(#coreG)"/><circle class="corering" cx="${cx}" cy="${cy}" r="74" fill="rgba(10,12,20,.85)" stroke="rgba(255,159,10,.5)" stroke-width="1.5" style="transition:stroke .2s"/>
    <text x="${cx}" y="${cy + 8}" text-anchor="middle" style="font:600 50px var(--mono);fill:#fff;filter:drop-shadow(0 0 12px rgba(255,159,10,.5))">${n}</text>
    <text x="${cx}" y="${cy + 34}" text-anchor="middle" style="font:600 11px var(--mono);letter-spacing:.2em;fill:#ff9f0a">NEED YOU</text></g>`;
  svg.setAttribute(
    'aria-label',
    `Radial map of workstreams by tool (rings) and project (sectors). ${live.length} open, ${n} waiting on you.`,
  );
  svg.innerHTML = out;

  const key = (el: Element, fn: () => void) =>
    el.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        fn();
      }
    });
  $$<SVGElement>('.arc', svg).forEach((a) => {
    const it = m.itemByKey.get(a.dataset.item as string);
    if (!it) return;
    a.onmousemove = (e) =>
      showTip(
        `<div class="t">${esc(it.title)}</div><div class="r"><i style="background:${TOOL_UI[it.tool].color}"></i>${esc(TOOL_UI[it.tool].name)}<b>${esc(m.projectByKey.get(it.projectKey)?.name ?? '')}</b></div><div class="r">${esc(STATUS_UI[it.status].name)}<b>${ago(it.ageMs)}</b></div>${it.sharedName ? `<div class="r">Shared<b>${esc(it.sharedName)}</b></div>` : ''}<div class="k">Click for details</div>`,
        e,
      );
    a.onmouseleave = hideTip;
    const go = () => {
      hideTip();
      openItem(it.key);
    };
    a.onclick = go;
    key(a, go);
  });
  $$<SVGElement>('.plabel', svg).forEach((l) => {
    const go = () => openProject(l.dataset.proj as string);
    l.onclick = go;
    key(l, go);
  });
  const core = $('#core', svg);
  const goCore = () => openNeeds();
  core.onclick = goCore;
  key(core, goCore);
}

export function openNeeds(): void {
  openList('Needs you', 'Decisions and approvals your agents are waiting on', () => byStatus('needs'), 'Nothing is waiting on you.');
}
