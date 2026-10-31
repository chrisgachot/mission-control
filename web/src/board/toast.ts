let node: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string): void {
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.innerHTML = '<i></i><span></span>';
    document.body.appendChild(node);
  }
  (node.querySelector('span') as HTMLElement).textContent = message;
  node.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => node?.classList.remove('show'), 2600);
}
