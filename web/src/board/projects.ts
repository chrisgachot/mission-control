import { $, $$, esc } from '../util.ts';
import { model, store } from '../store.ts';
import { isOpen } from '../model.ts';
import { TOOL_ORDER, TOOL_UI } from '../tools.ts';
import { badge, sharedTag, sparkPath } from './ui.ts';
import { openProject } from './views.ts';

export function renderProjects(): void {
  const m = model();
  const el = $('#projList');
  if (!m.projects.length) {
    el.innerHTML = `<div class="empty">No projects yet. Add the ones your agents should file work under in <a href="/setup" data-nav>Setup</a>.</div>`;
    return;
  }
  el.innerHTML = m.projects
    .map((p) => {
      const list = m.items.filter((i) => i.projectKey === p.key && (!store.tool || i.tool === store.tool));
      const open = list.filter(isOpen);
      const tools = TOOL_ORDER.filter((k) => open.some((i) => i.tool === k));
      const n = open.filter((i) => i.status === 'needs').length;
      const st = open.filter((i) => i.status === 'stale').length;
      const v = (m.pulse.get(p.key) ?? new Array<number>(30).fill(0)).slice(-14);
      const sum = v.reduce((a, b) => a + b, 0);
      const hot = n ? '#ff9f0a' : '#5ef2ff';
      const d = sparkPath(v, 120, 34);
      return `<button class="row" data-proj="${esc(p.key)}" aria-label="${esc(p.name)}: ${open.length} open, ${n} waiting on you, ${sum} updates in 14 days"><div class="rtext"><div class="rtitle">${esc(p.name)}</div><div class="rsub"><span class="pips">${tools.map((k) => `<i style="background:${TOOL_UI[k].color}" title="${esc(TOOL_UI[k].name)}"></i>`).join('')}</span><span>${open.length} open</span>${n ? badge('needs', n + ' need you') : ''}${st ? badge('stale', st + ' stale') : ''}${sharedTag(p.sharedName)}</div></div>
      <svg class="spark" width="120" height="34" viewBox="0 0 120 34" aria-hidden="true">${sum ? `<path d="${d}" fill="none" stroke="${hot}" stroke-width="1.8" stroke-linejoin="round" style="filter:drop-shadow(0 0 4px ${hot})"/>` : `<path d="M2 32H118" stroke="rgba(255,255,255,.14)" stroke-width="1.5" stroke-dasharray="2 4"/>`}</svg><span class="chev" aria-hidden="true">›</span></button>`;
    })
    .join('');
  $$<HTMLElement>('[data-proj]', el).forEach((b) => (b.onclick = () => openProject(b.dataset.proj as string)));
}
