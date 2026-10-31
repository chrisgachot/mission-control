/**
 * Byte encodings used by the crypto module. Pure functions, no WebCrypto, no Node APIs, so this
 * file runs identically in the Worker and in the browser bundle.
 */
import { CryptoError } from './errors.ts';

const B64U_RE = /^[A-Za-z0-9_-]*$/;

/** Bytes -> base64url without padding (RFC 4648 §5). */
export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Build the binary string in chunks: String.fromCharCode(...bigArray) can overflow the stack.
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url (padding optional) -> bytes.
 *
 * Strict on purpose: rejects '+', '/', whitespace and impossible lengths instead of silently
 * decoding something else. Every stored envelope and wrapped key passes through here, so a lax
 * decoder would make "two different strings, same bytes" possible and hide corruption.
 */
export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string') throw new CryptoError('invalid_encoding', 'expected a base64url string');
  const body = s.replace(/=+$/, '');
  if (!B64U_RE.test(body) || body.length % 4 === 1) {
    throw new CryptoError('invalid_encoding', 'not valid base64url');
  }
  const b = body.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 === 0 ? '' : '='.repeat(4 - (b.length % 4));
  let bin: string;
  try {
    bin = atob(b + pad);
  } catch {
    throw new CryptoError('invalid_encoding', 'not valid base64url');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();
// fatal: true -> invalid UTF-8 throws instead of producing U+FFFD. A decrypted plaintext that is
// not valid UTF-8 means something is wrong; we want to know rather than display mojibake.
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(s) as Uint8Array<ArrayBuffer>;
}

export function fromUtf8(bytes: ArrayBuffer | Uint8Array): string {
  return decoder.decode(bytes);
}

/** Copy into a fresh ArrayBuffer-backed Uint8Array (WebCrypto's BufferSource typing wants this). */
export function toBytes(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u8.length);
  out.set(u8);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Constant-time-ish byte comparison (length leak only). Used for non-secret checks too, harmless. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ---------- Recovery-code alphabet (Crockford base32) ----------

/**
 * Crockford's base32 alphabet: digits plus letters, minus I, L, O, U.
 * I/L/O are left out because they look like 1/1/0; U is left out to avoid accidental words.
 * 32 symbols -> exactly 5 bits per character.
 */
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encode bytes as Crockford base32 (no padding). Length must be a multiple of 5 bytes. */
export function base32Encode(bytes: Uint8Array): string {
  if (bytes.length % 5 !== 0) throw new CryptoError('invalid_input', 'base32 input must be a multiple of 5 bytes');
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += RECOVERY_ALPHABET[(buffer >> bits) & 31];
    }
    // Keep only the bits we have not emitted yet so `buffer` never grows past 32-bit range.
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** Decode Crockford base32 that has already been normalized to RECOVERY_ALPHABET symbols. */
export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  if ((s.length * 5) % 8 !== 0) throw new CryptoError('invalid_input', 'base32 length must encode whole bytes');
  const out = new Uint8Array((s.length * 5) / 8);
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = RECOVERY_ALPHABET.indexOf(ch);
    if (v < 0) throw new CryptoError('invalid_input', 'not a base32 symbol');
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}
