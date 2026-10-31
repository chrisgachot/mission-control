import type { Tool } from '../../../src/types.ts';
import { esc } from '../util.ts';
import { STATUS_UI, TOOL_UI } from '../tools.ts';
import type { UiStatus } from '../tools.ts';
import type { Item } from '../model.ts';

export function toolGlyph(tool: Tool, size = 30): string {
  const t = TOOL_UI[tool];
  return `<span class="glyph" style="width:${size}px;height:${size}px;background:${t.color}22;color:${t.color};box-shadow:inset 0 0 0 1px ${t.color}44"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${t.glyph}</svg></span>`;
}

export function badge(s: UiStatus, label?: string): string {
  return `<span class="badge ${s}">${STATUS_UI[s].icon}${esc(label ?? STATUS_UI[s].name)}</span>`;
}

export function sharedTag(name: string | null): string {
  return name ? `<span class="shared" title="Lives in a shared space">shared · ${esc(name)}</span>` : '';
}

export function sparkPath(vals: number[], w: number, h: number, pad = 2): string {
  const m = Math.max(...vals, 1);
  if (vals.length < 2) return '';
  return vals
    .map((v, i) => (i ? 'L' : 'M') + (pad + (i * (w - 2 * pad)) / (vals.length - 1)).toFixed(1) + ' ' + (h - pad - (v / m) * (h - 2 * pad)).toFixed(1))
    .join('');
}

export function itemLabel(i: Item): string {
  return `${i.title} (${STATUS_UI[i.status].name}, ${TOOL_UI[i.tool].name})`;
}
