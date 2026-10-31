import { b64u, unb64u } from '../../src/crypto/index.ts';

type Root = Element | Document;

export function $<T extends Element = HTMLElement>(sel: string, root: Root = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
}
export function $$<T extends Element = HTMLElement>(sel: string, root: Root = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

/** Escape text for HTML text and double- or single-quoted attributes. Every piece of user content goes through this. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** "5m ago", "3h ago", "2d ago". */
export function ago(ms: number): string {
  const h = ms / HOUR;
  if (h < 1) return Math.max(1, Math.round(ms / 60_000)) + 'm ago';
  if (h < 24) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

export function agoSince(then: number, now: number): string {
  return ago(Math.max(0, now - then));
}

export function plural(n: number, one: string, many = one + 's'): string {
  return n === 1 ? one : many;
}

export function greetingWord(d = new Date()): string {
  const h = d.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function encodeJsonB64u(v: unknown): string {
  return b64u(new TextEncoder().encode(JSON.stringify(v)));
}
export function decodeJsonB64u<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(unb64u(s))) as T;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
