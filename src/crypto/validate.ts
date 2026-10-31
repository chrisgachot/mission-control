/**
 * Structural validation for Envelope and WrappedKey.
 *
 * These run before any WebCrypto call, both in the Worker (on data arriving from browsers or other
 * spaces) and in the browser (on data arriving from the Worker). Checking exact byte lengths up front
 * means a malformed or hostile object fails with a clear typed error instead of reaching subtle.*
 * with odd inputs, and it caps sizes so a client cannot make the Worker store or process huge blobs.
 */
import type { Envelope, WrappedKey } from '../types.ts';
import { CryptoError } from './errors.ts';
import { unb64u } from './encoding.ts';

/** P-256 uncompressed point: 0x04 || X(32) || Y(32). */
export const P256_RAW_PUBLIC_LEN = 65;
export const GCM_IV_LEN = 12;
export const GCM_TAG_LEN = 16;
export const WRAP_SALT_LEN = 16;
/** Upper bound for one encrypted field (title, note, link): 64 KiB of ciphertext is far beyond any one-liner. */
export const MAX_ENVELOPE_CT_LEN = 64 * 1024;
/**
 * Upper bound for a wrapped PKCS8 P-256 private key. WebCrypto exports ~138 bytes (with public key)
 * or ~67 bytes (without); 512 leaves room for encoder differences and the 16-byte tag.
 */
export const MAX_WRAPPED_CT_LEN = 512;
export const MAX_KID_LEN = 128;

/**
 * Key ids are UUIDs for space keys and `user:<uuid>` for a user's own key (see userKeyKid). We accept a
 * conservative printable charset so a kid can never smuggle separators, whitespace or control bytes
 * into the HKDF info string or the AES-GCM additional data.
 */
const KID_RE = /^[A-Za-z0-9:_-]+$/;

export function assertKid(kid: unknown): asserts kid is string {
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > MAX_KID_LEN || !KID_RE.test(kid)) {
    throw new CryptoError('invalid_input', 'kid must be 1-128 chars of [A-Za-z0-9:_-]');
  }
}

function field(obj: Record<string, unknown>, name: string, code: 'invalid_envelope' | 'invalid_wrapped_key'): string {
  const v = obj[name];
  if (typeof v !== 'string') throw new CryptoError(code, `missing or non-string field: ${name}`);
  return v;
}

function decodedLen(s: string, name: string, code: 'invalid_envelope' | 'invalid_wrapped_key'): number {
  try {
    return unb64u(s).length;
  } catch {
    throw new CryptoError(code, `field is not base64url: ${name}`);
  }
}

/** Validate an unknown value as an Envelope and return a clean copy (extra fields dropped). */
export function validateEnvelope(value: unknown): Envelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CryptoError('invalid_envelope', 'envelope must be an object');
  }
  const o = value as Record<string, unknown>;
  if (o.v !== 1) throw new CryptoError('invalid_envelope', 'unsupported envelope version');
  const kid = field(o, 'kid', 'invalid_envelope');
  try {
    assertKid(kid);
  } catch {
    throw new CryptoError('invalid_envelope', 'invalid kid');
  }
  const epk = field(o, 'epk', 'invalid_envelope');
  const iv = field(o, 'iv', 'invalid_envelope');
  const ct = field(o, 'ct', 'invalid_envelope');
  if (decodedLen(epk, 'epk', 'invalid_envelope') !== P256_RAW_PUBLIC_LEN) {
    throw new CryptoError('invalid_envelope', 'epk must be a 65-byte P-256 point');
  }
  if (decodedLen(iv, 'iv', 'invalid_envelope') !== GCM_IV_LEN) {
    throw new CryptoError('invalid_envelope', 'iv must be 12 bytes');
  }
  const ctLen = decodedLen(ct, 'ct', 'invalid_envelope');
  if (ctLen < GCM_TAG_LEN || ctLen > MAX_ENVELOPE_CT_LEN) {
    throw new CryptoError('invalid_envelope', 'ct length out of range');
  }
  return { v: 1, kid, epk, iv, ct };
}

/** Parse Envelope JSON text (what *_enc columns hold). */
export function parseEnvelope(json: string): Envelope {
  if (typeof json !== 'string') throw new CryptoError('invalid_envelope', 'envelope JSON must be a string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CryptoError('invalid_envelope', 'envelope is not valid JSON');
  }
  return validateEnvelope(parsed);
}

const WRAP_KINDS = ['prf', 'recovery', 'user_pub', 'invite'] as const;

/** Validate an unknown value as a WrappedKey and return a clean copy (extra fields dropped). */
export function validateWrappedKey(value: unknown): WrappedKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CryptoError('invalid_wrapped_key', 'wrapped key must be an object');
  }
  const o = value as Record<string, unknown>;
  if (o.v !== 1) throw new CryptoError('invalid_wrapped_key', 'unsupported wrapped key version');
  const kind = o.kind;
  if (typeof kind !== 'string' || !(WRAP_KINDS as readonly string[]).includes(kind)) {
    throw new CryptoError('invalid_wrapped_key', 'unknown wrap kind');
  }
  const kid = field(o, 'kid', 'invalid_wrapped_key');
  try {
    assertKid(kid);
  } catch {
    throw new CryptoError('invalid_wrapped_key', 'invalid kid');
  }
  const salt = field(o, 'salt', 'invalid_wrapped_key');
  const iv = field(o, 'iv', 'invalid_wrapped_key');
  const ct = field(o, 'ct', 'invalid_wrapped_key');
  // For user_pub the "salt" slot carries the ECIES ephemeral public key; for the others it is the HKDF salt.
  const expectedSalt = kind === 'user_pub' ? P256_RAW_PUBLIC_LEN : WRAP_SALT_LEN;
  if (decodedLen(salt, 'salt', 'invalid_wrapped_key') !== expectedSalt) {
    throw new CryptoError('invalid_wrapped_key', `salt must be ${expectedSalt} bytes for kind ${kind}`);
  }
  if (decodedLen(iv, 'iv', 'invalid_wrapped_key') !== GCM_IV_LEN) {
    throw new CryptoError('invalid_wrapped_key', 'iv must be 12 bytes');
  }
  const ctLen = decodedLen(ct, 'ct', 'invalid_wrapped_key');
  if (ctLen < GCM_TAG_LEN + 1 || ctLen > MAX_WRAPPED_CT_LEN) {
    throw new CryptoError('invalid_wrapped_key', 'ct length out of range');
  }
  return { v: 1, kind: kind as WrappedKey['kind'], kid, salt, iv, ct };
}

/** Validate a raw P-256 public key string (structure only; the curve check happens on import). */
export function assertRawPublicKey(publicKeyRaw: unknown): asserts publicKeyRaw is string {
  if (typeof publicKeyRaw !== 'string') throw new CryptoError('invalid_key', 'public key must be a string');
  let bytes: Uint8Array;
  try {
    bytes = unb64u(publicKeyRaw);
  } catch {
    throw new CryptoError('invalid_key', 'public key is not base64url');
  }
  if (bytes.length !== P256_RAW_PUBLIC_LEN || bytes[0] !== 0x04) {
    throw new CryptoError('invalid_key', 'public key must be an uncompressed 65-byte P-256 point');
  }
}
