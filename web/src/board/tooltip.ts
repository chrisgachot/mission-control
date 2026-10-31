let tip: HTMLElement | null = null;
function el(): HTMLElement {
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  return tip;
}

/** `html` must already be escaped by the caller. */
export function showTip(html: string, e: { clientX: number; clientY: number }): void {
  const t = el();
  t.innerHTML = html;
  t.style.opacity = '1';
  moveTip(e);
}
export function moveTip(e: { clientX: number; clientY: number }): void {
  const t = el();
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  let x = e.clientX + 14;
  let y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
export function hideTip(): void {
  if (tip) tip.style.opacity = '0';
}
