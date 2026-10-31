import { $ } from '../util.ts';
import { esc } from '../util.ts';
import { model, store } from '../store.ts';
import { TOOL_ORDER, TOOL_UI } from '../tools.ts';
import type { Bucket } from '../model.ts';
import { hideTip, showTip } from './tooltip.ts';
import { bucketTitle, openBucket } from './views.ts';

function bucketLabel(b: Bucket): string {
  const range = model().range;
  if (range === '24h') return new Date(b.start).toLocaleTimeString('en-US', { hour: 'numeric' });
  const d = new Date(b.end - 1);
  if (range === '7d') return d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.getDate();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function renderActivity(): void {
  const m = model();
  const B = m.buckets;
  const svg = $<SVGSVGElement>('#activity');
  const tools = TOOL_ORDER.filter((k) => !store.tool || k === store.tool);
  const total = B.reduce((s, b) => s + tools.reduce((a, k) => a + b.counts[k], 0), 0);
  $('#actHint').textContent = `${total} ACTIONS · ${m.range.toUpperCase()}`;
  svg.setAttribute('aria-label', `Line chart of agent actions over the last ${m.range} by tool. ${total} actions in total. Use arrow keys to move through the chart and Enter to see what happened.`);

  const W = 640;
  const H = 230;
  const L = 34;
  const R = 96;
  const T = 12;
  const Bm = 28;
  const iw = W - L - R;
  const ih = H - T - Bm;
  if (!B.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="endlabel">No activity data yet</text>`;
    return;
  }
  const peak = Math.max(1, ...B.flatMap((b) => tools.map((k) => b.counts[k])));
  const max = Math.max(4, Math.ceil((peak * 1.1) / 4) * 4);
  const x = (i: number) => L + (B.length === 1 ? iw / 2 : (i * iw) / (B.length - 1));
  const y = (v: number) => T + ih - (v / max) * ih;
  const drawn = TOOL_ORDER.filter((k) => B.some((b) => b.counts[k] > 0) || store.tool === k);

  let o = `<defs>${TOOL_ORDER.map((k) => `<linearGradient id="ag-${k}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${TOOL_UI[k].color}" stop-opacity=".28"/><stop offset="1" stop-color="${TOOL_UI[k].color}" stop-opacity="0"/></linearGradient>`).join('')}</defs>`;
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = (max / ticks) * t;
    o += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><g class="axis"><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text></g>`;
  }
  const every = Math.ceil(B.length / 7);
  B.forEach((b, i) => {
    if (i % every === 0 || i === B.length - 1) o += `<g class="axis"><text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(bucketLabel(b))}</text></g>`;
  });
  if (!total && !store.tool) o += `<text x="${L + iw / 2}" y="${T + ih / 2}" text-anchor="middle" class="endlabel" style="fill:var(--ink3)">No agent activity in this window</text>`;

  const ends: Array<{ k: (typeof TOOL_ORDER)[number]; y: number }> = [];
  drawn.forEach((k) => {
    const pts = B.map((b, i) => [x(i), y(b.counts[k])] as const);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    const f = store.tool && store.tool !== k ? 'faded' : '';
    const last = pts[pts.length - 1] as readonly [number, number];
    o += `<path class="area ${f}" d="${line}L${last[0]} ${T + ih}L${(pts[0] as readonly [number, number])[0]} ${T + ih}Z" fill="url(#ag-${k})"/>`;
    o += `<path class="series ${f}" d="${line}" stroke="${TOOL_UI[k].color}" style="filter:drop-shadow(0 0 5px ${TOOL_UI[k].color})"/>`;
    if (!f) ends.push({ k, y: last[1] });
  });
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    const prev = ends[i - 1] as { y: number };
    const cur = ends[i] as { y: number };
    if (cur.y - prev.y < 15) cur.y = prev.y + 15;
  }
  const lastB = B[B.length - 1] as Bucket;
  ends.forEach((e) => {
    o += `<circle cx="${x(B.length - 1)}" cy="${y(lastB.counts[e.k])}" r="3.5" fill="${TOOL_UI[e.k].color}" stroke="#06070c" stroke-width="2"/><text class="endlabel" x="${W - R + 10}" y="${e.y + 4}">${esc(TOOL_UI[e.k].name)}</text>`;
  });
  o += `<g id="xh" style="display:none"><line id="xhl" y1="${T}" y2="${T + ih}" stroke="rgba(94,242,255,.5)" stroke-dasharray="3 3"/>${drawn.map((k) => `<circle id="xd-${k}" r="4.5" fill="${TOOL_UI[k].color}" stroke="#06070c" stroke-width="2"/>`).join('')}</g>`;
  o += `<rect id="hit" x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent" style="cursor:pointer" tabindex="0" role="button" aria-label="Activity by ${m.range === '24h' ? 'hour' : 'day'}. Arrow keys move, Enter opens."/>`;
  svg.innerHTML = o;

  const hit = $<SVGRectElement>('#hit', svg);
  const xh = $<SVGGElement>('#xh', svg);
  const xhl = $<SVGLineElement>('#xhl', svg);
  const idxAt = (e: MouseEvent) => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform((svg.getScreenCTM() as DOMMatrix).inverse());
    return Math.max(0, Math.min(B.length - 1, Math.round(((p.x - L) / iw) * (B.length - 1))));
  };
  const tipHtml = (b: Bucket) =>
    `<div class="t">${esc(bucketTitle(b))}</div>${tools
      .map((k) => `<div class="r"><i style="background:${TOOL_UI[k].color}"></i>${esc(TOOL_UI[k].name)}<b>${b.counts[k]}</b></div>`)
      .join('')}<div class="k">Click to see what happened</div>`;
  const cross = (i: number) => {
    const b = B[i] as Bucket;
    xh.style.display = '';
    xhl.setAttribute('x1', String(x(i)));
    xhl.setAttribute('x2', String(x(i)));
    drawn.forEach((k) => {
      const d = $<SVGCircleElement>('#xd-' + k, svg);
      d.setAttribute('cx', String(x(i)));
      d.setAttribute('cy', String(y(b.counts[k])));
      d.style.display = store.tool && store.tool !== k ? 'none' : '';
    });
    return b;
  };
  hit.onmousemove = (e) => showTip(tipHtml(cross(idxAt(e))), e);
  hit.onmouseleave = () => {
    xh.style.display = 'none';
    hideTip();
  };
  hit.onclick = (e) => {
    hideTip();
    openBucket(idxAt(e));
  };
  let kb = B.length - 1;
  hit.onfocus = () => cross(kb);
  hit.onblur = () => (xh.style.display = 'none');
  hit.onkeydown = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      kb = Math.max(0, Math.min(B.length - 1, kb + (e.key === 'ArrowLeft' ? -1 : 1)));
      cross(kb);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openBucket(kb);
    }
  };
}
