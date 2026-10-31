/** Detail sheet with a back stack. Views are functions so they re-render from live state after a refresh. */
import { $ } from '../util.ts';
import { hideTip } from './tooltip.ts';

export interface SheetView {
  title: string;
  /** Pre-escaped HTML. */
  sub?: string;
  /** Pre-escaped HTML. */
  body: string;
  after?: (body: HTMLElement) => void;
}
/** Return null when the thing the view showed no longer exists; the sheet then steps back. */
export type ViewFn = () => SheetView | null;

const stack: ViewFn[] = [];
let built = false;
let opener: HTMLElement | null = null;

function build(): void {
  if (built) return;
  built = true;
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="scrim" id="scrim"></div>
<div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="shTitle" tabindex="-1">
  <div class="grab"></div>
  <header>
    <button class="back" id="shBack" aria-label="Back">‹ Back</button>
    <div><h3 id="shTitle"></h3><div class="sh-sub" id="shSub"></div></div>
    <button class="close" id="shClose" aria-label="Close"><svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>
  </header>
  <div class="body" id="shBody"></div>
</div>`,
  );
  $('#shClose').onclick = closeSheet;
  $('#scrim').onclick = closeSheet;
  $('#shBack').onclick = () => {
    stack.pop();
    render();
  };
  addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSheet();
    } else if (e.key === 'Tab') {
      const f = Array.from($('#sheet').querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex="0"]')).filter(
        (x) => !x.hasAttribute('disabled') && x.offsetParent !== null,
      );
      if (!f.length) return;
      const first = f[0] as HTMLElement;
      const last = f[f.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === $('#sheet'))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

export function isOpen(): boolean {
  return built && $('#sheet').classList.contains('open');
}

function render(keepScroll = false): void {
  build();
  let v: SheetView | null = null;
  while (stack.length) {
    v = (stack[stack.length - 1] as ViewFn)();
    if (v) break;
    stack.pop();
  }
  if (!v) {
    closeSheet();
    return;
  }
  const wasOpen = isOpen();
  $('#shTitle').textContent = v.title;
  $('#shSub').innerHTML = v.sub ?? '';
  const body = $('#shBody');
  const scroll = body.scrollTop;
  body.innerHTML = v.body;
  $('#shBack').classList.toggle('show', stack.length > 1);
  $('#sheet').classList.add('open');
  $('#scrim').classList.add('open');
  body.scrollTop = wasOpen && keepScroll ? scroll : 0;
  v.after?.(body);
  if (!wasOpen) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    $('#shClose').focus();
  }
}

/** push=false starts a fresh stack (opening from the board); push=true adds a level (drilling in from the sheet). */
export function openSheet(fn: ViewFn, push = false): void {
  hideTip();
  build();
  if (!push) stack.length = 0;
  stack.push(fn);
  render();
}
export function refreshSheet(): void {
  if (isOpen()) render(true);
}
export function closeSheet(): void {
  if (!built) return;
  stack.length = 0;
  $('#sheet').classList.remove('open');
  $('#scrim').classList.remove('open');
  opener?.focus?.();
  opener = null;
}
