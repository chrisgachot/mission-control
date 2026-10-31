/**
 * Mission Control crypto. Contract: docs/ARCHITECTURE.md §3. Security track.
 *
 * Isomorphic: uses only globalThis.crypto (WebCrypto), TextEncoder/TextDecoder, atob/btoa. No Node
 * imports. The Worker imports it (it only ever calls encryptForKey) and esbuild bundles the same file
 * into the dashboard (which does everything else).
 *
 * Primitives, all standard WebCrypto, available identically in workerd and every current browser:
 *   - P-256 ECDH            key agreement (space keys, user keys, ephemeral keys)
 *   - HKDF-SHA256           derive a one-purpose AES key from an ECDH secret or a wrapping secret
 *   - AES-256-GCM           authenticated encryption, 12-byte random IV, 128-bit tag
 *
 * Domain separation: every derived key has an HKDF `info` that names its purpose
 *   "mission-control/v1/<kid>"             envelope (data) keys
 *   "mission-control/wrap/<kind>"          private-key wrapping keys (prf | recovery | invite | user_pub)
 * and every AES-GCM call authenticates utf8(kid) as additional data, so a ciphertext cannot be
 * relabelled with another key id (the open fails instead).
 *
 * Nothing here logs. Error messages name the failed check, never values.
 */
import type { Envelope, WrappedKey } from '../types.ts';
import { CryptoError } from './errors.ts';
import { b64u, unb64u, utf8, fromUtf8, randomBytes, toBytes, base32Encode, base32Decode, RECOVERY_ALPHABET } from './encoding.ts';
import {
  assertKid,
  assertRawPublicKey,
  validateEnvelope,
  validateWrappedKey,
  parseEnvelope,
  GCM_IV_LEN,
  WRAP_SALT_LEN,
  P256_RAW_PUBLIC_LEN,
} from './validate.ts';

export { CryptoError, isCryptoError } from './errors.ts';
export type { CryptoErrorCode } from './errors.ts';
export { b64u, unb64u, randomBytes } from './encoding.ts';
export { validateEnvelope, validateWrappedKey, parseEnvelope, assertKid, assertRawPublicKey } from './validate.ts';

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CryptoError('invalid_input', 'WebCrypto (crypto.subtle) is not available in this context');
  return s;
};

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const EMPTY = new Uint8Array(0);

/** HKDF info prefix for data envelopes. Part of the wire format: changing it breaks every stored envelope. */
const ENVELOPE_INFO_PREFIX = 'mission-control/v1/';
/** HKDF info prefix for key wrapping. Part of the wire format. */
const WRAP_INFO_PREFIX = 'mission-control/wrap/';

/** Minimum wrapping-secret length. PRF output is 32 bytes, invite secrets 32, recovery codes 20. */
const MIN_SECRET_LEN = 16;

/** Prefix that marks a user's own keypair inside the kid namespace (see userKeyKid). */
export const USER_KID_PREFIX = 'user:';

/**
 * The kid under which a user's own P-256 private key is wrapped. Space keys use bare UUIDs, so the
 * prefix cannot collide. The browser uses this to tell "my user key" apart from space keys in the
 * WrappedKey[] the Worker returns.
 */
export function userKeyKid(userId: string): string {
  const kid = USER_KID_PREFIX + userId;
  assertKid(kid);
  return kid;
}

// ---------- key import helpers (each one maps WebCrypto failures to typed errors) ----------

async function importPublic(publicKeyRaw: string): Promise<CryptoKey> {
  assertRawPublicKey(publicKeyRaw);
  try {
    // WebCrypto validates that the point is on the curve during import, which is what protects the
    // decrypt side against invalid-curve attacks via a hostile `epk`.
    return await subtle().importKey('raw', unb64u(publicKeyRaw), ECDH_P256, true, []);
  } catch {
    throw new CryptoError('invalid_key', 'public key is not a valid P-256 point');
  }
}

async function importPrivate(privateKeyPkcs8: string, extractable = false): Promise<CryptoKey> {
  if (typeof privateKeyPkcs8 !== 'string' || privateKeyPkcs8.length === 0) {
    throw new CryptoError('invalid_key', 'private key must be a non-empty base64url PKCS8 string');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unb64u(privateKeyPkcs8);
  } catch {
    throw new CryptoError('invalid_key', 'private key is not base64url');
  }
  try {
    return await subtle().importKey('pkcs8', bytes, ECDH_P256, extractable, ['deriveBits']);
  } catch {
    throw new CryptoError('invalid_key', 'private key is not a valid P-256 PKCS8 key');
  }
}

/** HKDF-SHA256(ikm, salt, info) -> AES-256-GCM key with a single usage. */
async function hkdfAesKey(ikm: Uint8Array, salt: Uint8Array, info: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const s = subtle();
  const base = await s.importKey('raw', toBytes(ikm), 'HKDF', false, ['deriveKey']);
  return s.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toBytes(salt), info: utf8(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** ECDH(priv, pub) -> 32-byte shared secret (the X coordinate). */
async function ecdh(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  return new Uint8Array(bits);
}

async function newEphemeral(): Promise<{ key: CryptoKeyPair; publicRaw: string }> {
  const key = (await subtle().generateKey(ECDH_P256, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = await subtle().exportKey('raw', key.publicKey);
  return { key, publicRaw: b64u(raw as ArrayBuffer) };
}

async function gcmEncrypt(key: CryptoKey, plaintext: Uint8Array, kid: string): Promise<{ iv: string; ct: string }> {
  const iv = randomBytes(GCM_IV_LEN);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(kid), tagLength: 128 }, key, toBytes(plaintext));
  return { iv: b64u(iv), ct: b64u(ct) };
}

async function gcmDecrypt(key: CryptoKey, ivB64u: string, ctB64u: string, kid: string, failCode: 'decrypt_failed' | 'unwrap_failed'): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64u(ivB64u), additionalData: utf8(kid), tagLength: 128 }, key, unb64u(ctB64u));
    return new Uint8Array(pt);
  } catch {
    // One generic error for wrong key, wrong kid, wrong secret and tampering: GCM cannot tell them apart,
    // and we do not want to pretend otherwise.
    throw new CryptoError(failCode, failCode === 'decrypt_failed' ? 'could not decrypt envelope' : 'could not unwrap key');
  }
}

/** Re-import a just-unwrapped PKCS8 to prove it is a usable P-256 key before handing it back. */
async function checkedPkcs8(bytes: Uint8Array): Promise<string> {
  const s = b64u(bytes);
  await importPrivate(s);
  return s;
}

// ---------- public surface (exact signatures from ARCHITECTURE §3) ----------

export async function generateSpaceKeyPair(): Promise<{ publicKeyRaw: string; privateKeyPkcs8: string }> {
  // Extractable because the private half must be exported as PKCS8 to be wrapped for each holder.
  const kp = (await subtle().generateKey(ECDH_P256, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = (await subtle().exportKey('raw', kp.publicKey)) as ArrayBuffer;
  const priv = (await subtle().exportKey('pkcs8', kp.privateKey)) as ArrayBuffer;
  return { publicKeyRaw: b64u(pub), privateKeyPkcs8: b64u(priv) };
}

/**
 * ECIES encrypt `plaintext` to the space public key `publicKeyRaw` (key id `kid`).
 *  1. fresh ephemeral P-256 keypair e
 *  2. shared = ECDH(e.priv, spacePub); aesKey = HKDF-SHA256(shared, salt = empty, info = "mission-control/v1/" + kid)
 *  3. ct = AES-256-GCM(aesKey, iv = 12 random bytes, utf8(plaintext), additionalData = utf8(kid))
 * A fresh ephemeral key per message means a fresh AES key per message, so IV reuse across messages
 * cannot happen even with a bad RNG on the IV alone.
 */
export async function encryptForKey(kid: string, publicKeyRaw: string, plaintext: string): Promise<Envelope> {
  assertKid(kid);
  if (typeof plaintext !== 'string') throw new CryptoError('invalid_input', 'plaintext must be a string');
  const recipient = await importPublic(publicKeyRaw);
  const eph = await newEphemeral();
  const shared = await ecdh(eph.key.privateKey, recipient);
  const aesKey = await hkdfAesKey(shared, EMPTY, ENVELOPE_INFO_PREFIX + kid, 'encrypt');
  const { iv, ct } = await gcmEncrypt(aesKey, utf8(plaintext), kid);
  return { v: 1, kid, epk: eph.publicRaw, iv, ct };
}

/** Open an Envelope with the matching space private key (PKCS8, base64url). Throws CryptoError. */
export async function decryptEnvelope(env: Envelope, privateKeyPkcs8: string): Promise<string> {
  const e = validateEnvelope(env);
  const priv = await importPrivate(privateKeyPkcs8);
  const epk = await importPublic(e.epk);
  const shared = await ecdh(priv, epk);
  const aesKey = await hkdfAesKey(shared, EMPTY, ENVELOPE_INFO_PREFIX + e.kid, 'decrypt');
  const pt = await gcmDecrypt(aesKey, e.iv, e.ct, e.kid, 'decrypt_failed');
  try {
    return fromUtf8(pt);
  } catch {
    throw new CryptoError('decrypt_failed', 'decrypted bytes are not valid UTF-8');
  }
}

/**
 * Wrap a private key with a high-entropy secret (PRF output, recovery code bytes, invite secret).
 *   wrapKey = HKDF-SHA256(secret, salt = 16 fresh random bytes, info = "mission-control/wrap/" + kind)
 *   ct      = AES-256-GCM(wrapKey, iv, pkcs8 bytes, additionalData = utf8(kid))
 * No password stretching (PBKDF2/Argon2) because every secret here is >= 128 bits of real randomness:
 * PRF outputs and invite secrets are 256-bit, recovery codes 160-bit. HKDF is the right tool for
 * uniformly random input keying material; stretching would add latency and no security.
 */
export async function wrapWithSecret(
  kind: 'recovery' | 'invite' | 'prf',
  kid: string,
  privateKeyPkcs8: string,
  secret: Uint8Array,
): Promise<WrappedKey> {
  if (kind !== 'recovery' && kind !== 'invite' && kind !== 'prf') throw new CryptoError('invalid_input', 'unknown wrap kind');
  assertKid(kid);
  if (!(secret instanceof Uint8Array) || secret.length < MIN_SECRET_LEN) {
    throw new CryptoError('invalid_input', `secret must be at least ${MIN_SECRET_LEN} bytes`);
  }
  await importPrivate(privateKeyPkcs8); // refuse to wrap something that is not a P-256 private key
  const salt = randomBytes(WRAP_SALT_LEN);
  const key = await hkdfAesKey(secret, salt, WRAP_INFO_PREFIX + kind, 'encrypt');
  const { iv, ct } = await gcmEncrypt(key, unb64u(privateKeyPkcs8), kid);
  return { v: 1, kind, kid, salt: b64u(salt), iv, ct };
}

export async function unwrapWithSecret(w: WrappedKey, secret: Uint8Array): Promise<string> {
  const v = validateWrappedKey(w);
  if (v.kind === 'user_pub') throw new CryptoError('invalid_wrapped_key', 'user_pub wraps open with unwrapWithUserPriv');
  if (!(secret instanceof Uint8Array) || secret.length < MIN_SECRET_LEN) {
    throw new CryptoError('invalid_input', `secret must be at least ${MIN_SECRET_LEN} bytes`);
  }
  const key = await hkdfAesKey(secret, unb64u(v.salt), WRAP_INFO_PREFIX + v.kind, 'decrypt');
  const pkcs8 = await gcmDecrypt(key, v.iv, v.ct, v.kid, 'unwrap_failed');
  return checkedPkcs8(pkcs8);
}

/**
 * Wrap a private key to another user's P-256 public key (ECIES), so an admin can hand a rotated
 * shared key to a member who is not present. The ephemeral public key goes in `salt`.
 *   shared  = ECDH(e.priv, userPub); wrapKey = HKDF-SHA256(shared, salt = empty, info = "mission-control/wrap/user_pub")
 *   ct      = AES-256-GCM(wrapKey, iv, pkcs8 bytes, additionalData = utf8(kid))
 * The info string differs from the envelope one, so a wrapped key can never be mistaken for (or opened
 * as) a data envelope and vice versa, even though both are ECIES to a P-256 key.
 */
export async function wrapForUserPub(kid: string, privateKeyPkcs8: string, userPublicKeyRaw: string): Promise<WrappedKey> {
  assertKid(kid);
  await importPrivate(privateKeyPkcs8);
  const recipient = await importPublic(userPublicKeyRaw);
  const eph = await newEphemeral();
  const shared = await ecdh(eph.key.privateKey, recipient);
  const key = await hkdfAesKey(shared, EMPTY, WRAP_INFO_PREFIX + 'user_pub', 'encrypt');
  const { iv, ct } = await gcmEncrypt(key, unb64u(privateKeyPkcs8), kid);
  return { v: 1, kind: 'user_pub', kid, salt: eph.publicRaw, iv, ct };
}

export async function unwrapWithUserPriv(w: WrappedKey, userPrivateKeyPkcs8: string): Promise<string> {
  const v = validateWrappedKey(w);
  if (v.kind !== 'user_pub') throw new CryptoError('invalid_wrapped_key', 'expected a user_pub wrap');
  const priv = await importPrivate(userPrivateKeyPkcs8);
  const epk = await importPublic(v.salt);
  const shared = await ecdh(priv, epk);
  const key = await hkdfAesKey(shared, EMPTY, WRAP_INFO_PREFIX + 'user_pub', 'decrypt');
  const pkcs8 = await gcmDecrypt(key, v.iv, v.ct, v.kid, 'unwrap_failed');
  return checkedPkcs8(pkcs8);
}

// ---------- recovery codes ----------

/** 20 random bytes = 160 bits = exactly 32 Crockford base32 symbols = 8 groups of 4. */
const RECOVERY_BYTES = 20;
const RECOVERY_SYMBOLS = 32;
const RECOVERY_GROUP = 4;

/**
 * A one-time recovery code, e.g. "7K3M-QX9P-...". 160 bits from crypto.getRandomValues, written in
 * Crockford base32 (no I, L, O, U) and grouped in fours for reading aloud or copying by hand.
 * Shown once; the server never sees it (only what it wraps).
 */
export function generateRecoveryCode(): string {
  const symbols = base32Encode(randomBytes(RECOVERY_BYTES));
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += RECOVERY_GROUP) groups.push(symbols.slice(i, i + RECOVERY_GROUP));
  return groups.join('-');
}

/**
 * Turn a typed recovery code back into its 20 secret bytes.
 * Forgiving about presentation: case-insensitive; ignores spaces, dashes, dots and underscores; and
 * applies Crockford's look-alike mapping (O -> 0, I and L -> 1). Strict about content: anything else
 * (including U) or a wrong symbol count throws invalid_recovery_code. A typo that still yields 32
 * valid symbols decodes to the wrong secret, and the unwrap then fails with unwrap_failed.
 */
export function recoveryCodeToSecret(code: string): Uint8Array {
  if (typeof code !== 'string') throw new CryptoError('invalid_recovery_code', 'recovery code must be a string');
  const normalized = code
    .toUpperCase()
    .replace(/[\s\-._]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (normalized.length !== RECOVERY_SYMBOLS) {
    throw new CryptoError('invalid_recovery_code', `recovery code must have ${RECOVERY_SYMBOLS} characters`);
  }
  for (const ch of normalized) {
    if (!RECOVERY_ALPHABET.includes(ch)) throw new CryptoError('invalid_recovery_code', 'recovery code has an invalid character');
  }
  return base32Decode(normalized);
}

// ---------- small helpers used by the Worker and the vault (outside the §3 contract) ----------

/** SHA-256 of a UTF-8 string, base64url. Used for session ids and bearer-token hashes. */
export async function sha256B64u(input: string): Promise<string> {
  const d = await subtle().digest('SHA-256', utf8(input));
  return b64u(d);
}

/**
 * Invite claim proof (review 1, finding 1). The invite id travels in the URL path and can leak (logs,
 * link unfurlers, history); the secret travels only in the fragment. To register with an invite, the
 * browser must show it knows the secret without revealing it:
 *   claim     = base64url(SHA-256(utf8("mission-control/invite-claim/v1") || secretBytes))   (sent at registration)
 *   claimHash = sha256B64u(claim)                                                           (stored at invite creation)
 * Both are one-way and domain-separated from the HKDF that wraps the key (different construction and
 * label), so the server, which sees claimHash at creation and claim at registration, still cannot derive
 * the wrapping key or unwrap the invite.
 */
const INVITE_CLAIM_PREFIX = 'mission-control/invite-claim/v1';
export async function inviteClaimFromSecret(secret: Uint8Array): Promise<string> {
  if (!(secret instanceof Uint8Array) || secret.length < MIN_SECRET_LEN) {
    throw new CryptoError('invalid_input', `secret must be at least ${MIN_SECRET_LEN} bytes`);
  }
  const prefix = utf8(INVITE_CLAIM_PREFIX);
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix, 0);
  input.set(secret, prefix.length);
  return b64u(await subtle().digest('SHA-256', input));
}

/** A random bearer token / cookie value: 32 bytes, base64url (43 chars). */
export function randomToken(bytes = 32): string {
  return b64u(randomBytes(bytes));
}

/**
 * The PRF evaluation input ("salt") every Mission Control passkey is asked to evaluate.
 * It is a fixed public constant, SHA-256("mission-control/prf/v1"). That is fine: the PRF output is
 * HMAC(credential-secret, salt), so it is already unique per credential and per RP id; the salt only
 * provides domain separation from other uses of the same credential. Fixing it means the login options
 * do not need to know which credential is coming (discoverable login) and the browser can compute it
 * itself instead of trusting the server's copy.
 */
let prfSaltCache: Promise<Uint8Array<ArrayBuffer>> | null = null;
export function prfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  prfSaltCache ??= subtle()
    .digest('SHA-256', utf8('mission-control/prf/v1'))
    .then((d) => new Uint8Array(d));
  return prfSaltCache;
}

/** Derive the raw (65-byte, base64url) public key from a PKCS8 P-256 private key. */
export async function publicKeyFromPrivate(privateKeyPkcs8: string): Promise<string> {
  const k = await importPrivate(privateKeyPkcs8, true);
  const jwk = await subtle().exportKey('jwk', k);
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new CryptoError('invalid_key', 'could not derive public key');
  const x = unb64u(jwk.x);
  const y = unb64u(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new CryptoError('invalid_key', 'unexpected coordinate length');
  const raw = new Uint8Array(P256_RAW_PUBLIC_LEN);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 33);
  return b64u(raw);
}

/**
 * True if `publicKeyRaw` is a 65-byte uncompressed point that WebCrypto accepts as a P-256 key (on the
 * curve). The Worker checks this before storing any public key, so a bad key cannot later make
 * encryptForKey fail for every agent report.
 */
export async function isValidPublicKey(publicKeyRaw: unknown): Promise<boolean> {
  try {
    await importPublic(publicKeyRaw as string);
    return true;
  } catch {
    return false;
  }
}

/** Generate a user's own P-256 keypair. Same shape as a space key; separate name for readability. */
export const generateUserKeyPair = generateSpaceKeyPair;

/** Parse an *_enc column value, or return null for null. Throws CryptoError on malformed JSON. */
export function parseEnvelopeOrNull(json: string | null): Envelope | null {
  return json == null ? null : parseEnvelope(json);
}
