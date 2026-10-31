/**
 * STUB. The Security track replaces this file with the real implementation.
 * Signatures are the contract (docs/ARCHITECTURE.md §3). Other tracks import only from here.
 */
import type { Envelope, WrappedKey } from '../types.ts';

export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 === 0 ? '' : '='.repeat(4 - (b.length % 4));
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const notImplemented = (name: string) => new Error(`crypto.${name} not implemented yet (Security track)`);

export async function generateSpaceKeyPair(): Promise<{ publicKeyRaw: string; privateKeyPkcs8: string }> {
  throw notImplemented('generateSpaceKeyPair');
}
export async function encryptForKey(_kid: string, _publicKeyRaw: string, _plaintext: string): Promise<Envelope> {
  throw notImplemented('encryptForKey');
}
export async function decryptEnvelope(_env: Envelope, _privateKeyPkcs8: string): Promise<string> {
  throw notImplemented('decryptEnvelope');
}
export async function wrapWithSecret(
  _kind: 'recovery' | 'invite' | 'prf',
  _kid: string,
  _privateKeyPkcs8: string,
  _secret: Uint8Array,
): Promise<WrappedKey> {
  throw notImplemented('wrapWithSecret');
}
export async function unwrapWithSecret(_w: WrappedKey, _secret: Uint8Array): Promise<string> {
  throw notImplemented('unwrapWithSecret');
}
export async function wrapForUserPub(_kid: string, _privateKeyPkcs8: string, _userPublicKeyRaw: string): Promise<WrappedKey> {
  throw notImplemented('wrapForUserPub');
}
export async function unwrapWithUserPriv(_w: WrappedKey, _userPrivateKeyPkcs8: string): Promise<string> {
  throw notImplemented('unwrapWithUserPriv');
}
export function generateRecoveryCode(): string {
  throw notImplemented('generateRecoveryCode');
}
export function recoveryCodeToSecret(_code: string): Uint8Array {
  throw notImplemented('recoveryCodeToSecret');
}
