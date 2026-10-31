import { esc } from './util.ts';

export const BACKDROP = `<div class="backdrop"><div class="haze"></div><div class="grid"></div><div class="scan"></div></div>`;

/** Centered single-card page used by first run, unlock, invite and connect. */
export function cardPage(inner: string): string {
  return `${BACKDROP}<main class="center"><div class="card">${inner}</div></main>`;
}

export function brandRow(label: string): string {
  return `<div class="brand"><span class="dot"></span>${esc(label)}</div>`;
}

export function errorBox(): string {
  return `<div class="err" role="alert" hidden></div>`;
}

export function showError(root: Element, message: string): void {
  const el = root.querySelector<HTMLElement>('.err');
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

export function webauthnAvailable(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials;
}

export const NO_WEBAUTHN =
  'This browser cannot create passkeys. Use a current version of Chrome, Safari, Edge or Firefox on a device with Face ID, Touch ID, Windows Hello or a security key.';
