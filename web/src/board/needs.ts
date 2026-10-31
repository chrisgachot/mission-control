import { $, $$, esc, ago } from '../util.ts';
import { model } from '../store.ts';
import { TOOL_UI } from '../tools.ts';
import { sortedNeeds } from './hud.ts';
import { openItem, runAction } from './views.ts';
import { openNeeds } from './reactor.ts';
import { toast } from './toast.ts';
import { sharedTag, toolGlyph } from './ui.ts';

const SHOW = 6;
let armed: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;

export function renderNeeds(): void {
  const m = model();
  const all = sortedNeeds().sort((a, b) => a.ageMs - b.ageMs);
  const list = all.slice(0, SHOW);
  $('#needsHint').textContent = all.length ? `${all.length} WAITING` : 'ALL CLEAR';
  const el = $('#needsList');
  el.innerHTML = list.length
    ? list
        .map(
          (i) =>
            `<div class="row" role="button" tabindex="0" data-item="${esc(i.key)}" aria-label="${esc(i.title)}. ${esc(i.next)}">${toolGlyph(i.tool)}<div class="rtext"><div class="rtitle">${esc(i.title)}</div><div class="rsub"><span>${esc(TOOL_UI[i.tool].name)}</span><span>${esc(m.projectByKey.get(i.projectKey)?.name ?? '')}</span>${sharedTag(i.sharedName)}<span class="m">${ago(i.ageMs)}</span></div></div>${
              i.readOnly ? '<span class="chev" aria-hidden="true">›</span>' : `<button class="pill" data-quick="${esc(i.key)}">${esc(TOOL_UI[i.tool].verb)}</button>`
            }</div>`,
        )
        .join('')
    : `<div class="empty">Nothing is waiting on you. Nice.</div>`;
  $('#needsAll').textContent = all.length > SHOW ? `See all ${all.length}` : 'See all';
  $$<HTMLElement>('.row', el).forEach((r) => {
    r.onclick = () => openItem(r.dataset.item as string);
    r.onkeydown = (e) => {
      if (e.target === r && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        r.click();
      }
    };
  });
  $$<HTMLElement>('[data-quick]', el).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const it = m.itemByKey.get(b.dataset.quick as string);
      if (!it) return;
      if (armed?.key === it.key && b.classList.contains('ok')) {
        clearTimeout(armed.timer);
        armed = null;
        void runAction(it, 'handled');
        return;
      }
      if (armed) clearTimeout(armed.timer);
      b.classList.add('ok');
      b.textContent = 'Confirm';
      const label = TOOL_UI[it.tool].verb;
      armed = {
        key: it.key,
        timer: setTimeout(() => {
          b.classList.remove('ok');
          b.textContent = label;
          armed = null;
        }, 4000),
      };
      toast('Tap again to mark it handled');
    };
  });
}

export function wireNeedsAll(): void {
  $('#needsAll').onclick = () => openNeeds();
}
