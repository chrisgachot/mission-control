// Unit tests for src/crypto (Security track). Runs inside workerd via @cloudflare/vitest-plugin, i.e.
// the same WebCrypto implementation the Worker uses in production.
import { describe, it, expect } from 'vitest';
import {
  b64u,
  unb64u,
  generateSpaceKeyPair,
  encryptForKey,
  decryptEnvelope,
  wrapWithSecret,
  unwrapWithSecret,
  wrapForUserPub,
  unwrapWithUserPriv,
  generateRecoveryCode,
  recoveryCodeToSecret,
  parseEnvelope,
  validateWrappedKey,
  publicKeyFromPrivate,
  isValidPublicKey,
  userKeyKid,
  randomBytes,
  CryptoError,
} from '../src/crypto/index.ts';
import type { Envelope, WrappedKey } from '../src/types.ts';

const KID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';

/** Flip one bit in the middle of a base64url field. */
function flipByte(field: string, index?: number): string {
  const bytes = unb64u(field);
  const i = index ?? Math.floor(bytes.length / 2);
  bytes[i] = (bytes[i] ?? 0) ^ 0x01;
  return b64u(bytes);
}

async function expectCryptoError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    expect((e as CryptoError).code).toBe(code);
    return;
  }
  throw new Error(`expected CryptoError(${code}), got success`);
}

describe('encoding', () => {
  it('b64u round-trips and rejects non-url-safe input', () => {
    const bytes = randomBytes(37);
    expect(Array.from(unb64u(b64u(bytes)))).toEqual(Array.from(bytes));
    expect(b64u(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(() => unb64u('ab+/')).toThrow(CryptoError);
    expect(() => unb64u('a')).toThrow(CryptoError);
  });
});

describe('space keys and envelopes', () => {
  it('generates a 65-byte raw public key and a PKCS8 private key that match', async () => {
    const kp = await generateSpaceKeyPair();
    expect(unb64u(kp.publicKeyRaw).length).toBe(65);
    expect(unb64u(kp.publicKeyRaw)[0]).toBe(0x04);
    expect(await publicKeyFromPrivate(kp.privateKeyPkcs8)).toBe(kp.publicKeyRaw);
    expect(await isValidPublicKey(kp.publicKeyRaw)).toBe(true);
  });

  it('encryptForKey / decryptEnvelope round trip (including unicode and empty string)', async () => {
    const kp = await generateSpaceKeyPair();
    for (const text of ['Approve $214 for the vendor', '', 'Größe — 日本語 — 🚀']) {
      const env = await encryptForKey(KID, kp.publicKeyRaw, text);
      expect(env.v).toBe(1);
      expect(env.kid).toBe(KID);
      expect(unb64u(env.epk).length).toBe(65);
      expect(unb64u(env.iv).length).toBe(12);
      // Survives the JSON text form stored in *_enc columns.
      const parsed = parseEnvelope(JSON.stringify(env));
      expect(await decryptEnvelope(parsed, kp.privateKeyPkcs8)).toBe(text);
    }
  });

  it('uses a fresh ephemeral key and IV per message', async () => {
    const kp = await generateSpaceKeyPair();
    const a = await encryptForKey(KID, kp.publicKeyRaw, 'same');
    const b = await encryptForKey(KID, kp.publicKeyRaw, 'same');
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
  });

  it('detects tampering with ct, iv and epk', async () => {
    const kp = await generateSpaceKeyPair();
    const env = await encryptForKey(KID, kp.publicKeyRaw, 'tests passing');
    await expectCryptoError(decryptEnvelope({ ...env, ct: flipByte(env.ct) }, kp.privateKeyPkcs8), 'decrypt_failed');
    await expectCryptoError(decryptEnvelope({ ...env, ct: flipByte(env.ct, unb64u(env.ct).length - 1) }, kp.privateKeyPkcs8), 'decrypt_failed');
    await expectCryptoError(decryptEnvelope({ ...env, iv: flipByte(env.iv) }, kp.privateKeyPkcs8), 'decrypt_failed');
    // A flipped epk is either off-curve (invalid_key) or a different point (decrypt_failed); both must throw.
    await expect(decryptEnvelope({ ...env, epk: flipByte(env.epk, 64) }, kp.privateKeyPkcs8)).rejects.toBeInstanceOf(CryptoError);
  });

  it('fails when the kid (additional data + HKDF info) is changed', async () => {
    const kp = await generateSpaceKeyPair();
    const env = await encryptForKey(KID, kp.publicKeyRaw, 'pick a timeout');
    const relabelled: Envelope = { ...env, kid: 'another-kid' };
    await expectCryptoError(decryptEnvelope(relabelled, kp.privateKeyPkcs8), 'decrypt_failed');
  });

  it('fails with the wrong private key', async () => {
    const a = await generateSpaceKeyPair();
    const b = await generateSpaceKeyPair();
    const env = await encryptForKey(KID, a.publicKeyRaw, 'secret');
    await expectCryptoError(decryptEnvelope(env, b.privateKeyPkcs8), 'decrypt_failed');
  });

  it('rejects malformed envelopes and keys with typed errors', async () => {
    const kp = await generateSpaceKeyPair();
    const env = await encryptForKey(KID, kp.publicKeyRaw, 'x');
    expect(() => parseEnvelope('not json')).toThrow(CryptoError);
    expect(() => parseEnvelope(JSON.stringify({ ...env, v: 2 }))).toThrow(CryptoError);
    expect(() => parseEnvelope(JSON.stringify({ ...env, iv: b64u(randomBytes(16)) }))).toThrow(CryptoError);
    expect(() => parseEnvelope(JSON.stringify({ ...env, epk: b64u(randomBytes(33)) }))).toThrow(CryptoError);
    expect(() => parseEnvelope(JSON.stringify({ ...env, kid: 'bad kid with spaces' }))).toThrow(CryptoError);
    await expectCryptoError(encryptForKey('', kp.publicKeyRaw, 'x'), 'invalid_input');
    await expectCryptoError(encryptForKey(KID, b64u(randomBytes(65)), 'x'), 'invalid_key');
    await expectCryptoError(decryptEnvelope(env, 'AAAA'), 'invalid_key');
    // 0x04 || random X,Y is (overwhelmingly) not on the curve.
    const offCurve = new Uint8Array(65);
    offCurve.set(randomBytes(64), 1);
    offCurve[0] = 0x04;
    expect(await isValidPublicKey(b64u(offCurve))).toBe(false);
  });
});

describe('wrapWithSecret / unwrapWithSecret', () => {
  for (const kind of ['recovery', 'invite', 'prf'] as const) {
    it(`round trips for kind ${kind}, and rejects the wrong secret, tampering and a changed kid`, async () => {
      const kp = await generateSpaceKeyPair();
      const secret = kind === 'recovery' ? recoveryCodeToSecret(generateRecoveryCode()) : randomBytes(32);
      const w = await wrapWithSecret(kind, KID, kp.privateKeyPkcs8, secret);
      expect(w.kind).toBe(kind);
      expect(w.kid).toBe(KID);
      expect(unb64u(w.salt).length).toBe(16);
      expect(validateWrappedKey(JSON.parse(JSON.stringify(w)))).toEqual(w);

      const back = await unwrapWithSecret(w, secret);
      expect(back).toBe(kp.privateKeyPkcs8);
      // The unwrapped key still decrypts data for its public key.
      const env = await encryptForKey(KID, kp.publicKeyRaw, 'ok');
      expect(await decryptEnvelope(env, back)).toBe('ok');

      await expectCryptoError(unwrapWithSecret(w, randomBytes(secret.length)), 'unwrap_failed');
      await expectCryptoError(unwrapWithSecret({ ...w, ct: flipByte(w.ct) }, secret), 'unwrap_failed');
      await expectCryptoError(unwrapWithSecret({ ...w, salt: flipByte(w.salt) }, secret), 'unwrap_failed');
      await expectCryptoError(unwrapWithSecret({ ...w, kid: 'other-kid' }, secret), 'unwrap_failed');
    });
  }

  it('binds the kind into the derived key (a prf wrap does not open as recovery)', async () => {
    const kp = await generateSpaceKeyPair();
    const secret = randomBytes(32);
    const w = await wrapWithSecret('prf', KID, kp.privateKeyPkcs8, secret);
    await expectCryptoError(unwrapWithSecret({ ...w, kind: 'recovery' }, secret), 'unwrap_failed');
  });

  it('refuses short secrets and non-keys', async () => {
    const kp = await generateSpaceKeyPair();
    await expectCryptoError(wrapWithSecret('invite', KID, kp.privateKeyPkcs8, randomBytes(8)), 'invalid_input');
    await expectCryptoError(wrapWithSecret('invite', KID, b64u(randomBytes(138)), randomBytes(32)), 'invalid_key');
  });

  it('wraps a user key under its user: kid', async () => {
    const kp = await generateSpaceKeyPair();
    const kid = userKeyKid('0b6c1f8e-7c41-4b8a-9d0e-2f3a4b5c6d7e');
    const secret = randomBytes(32);
    const w = await wrapWithSecret('prf', kid, kp.privateKeyPkcs8, secret);
    expect(await unwrapWithSecret(w, secret)).toBe(kp.privateKeyPkcs8);
  });
});

describe('wrapForUserPub / unwrapWithUserPriv', () => {
  it('round trips, and rejects the wrong user key, tampering and a changed kid', async () => {
    const space = await generateSpaceKeyPair();
    const alice = await generateSpaceKeyPair();
    const bob = await generateSpaceKeyPair();
    const w: WrappedKey = await wrapForUserPub(KID, space.privateKeyPkcs8, alice.publicKeyRaw);
    expect(w.kind).toBe('user_pub');
    expect(unb64u(w.salt).length).toBe(65); // ephemeral public key
    expect(await unwrapWithUserPriv(w, alice.privateKeyPkcs8)).toBe(space.privateKeyPkcs8);

    await expectCryptoError(unwrapWithUserPriv(w, bob.privateKeyPkcs8), 'unwrap_failed');
    await expectCryptoError(unwrapWithUserPriv({ ...w, ct: flipByte(w.ct) }, alice.privateKeyPkcs8), 'unwrap_failed');
    await expectCryptoError(unwrapWithUserPriv({ ...w, kid: 'other-kid' }, alice.privateKeyPkcs8), 'unwrap_failed');
    // Kinds are not interchangeable.
    await expectCryptoError(unwrapWithSecret(w, randomBytes(32)), 'invalid_wrapped_key');
  });

  it('a wrapped key cannot be opened as an envelope (domain separation)', async () => {
    const space = await generateSpaceKeyPair();
    const alice = await generateSpaceKeyPair();
    const w = await wrapForUserPub(KID, space.privateKeyPkcs8, alice.publicKeyRaw);
    // Same ECIES shape, different HKDF info: opening it as an envelope must fail, not yield the key.
    const asEnvelope: Envelope = { v: 1, kid: w.kid, epk: w.salt, iv: w.iv, ct: w.ct };
    await expectCryptoError(decryptEnvelope(asEnvelope, alice.privateKeyPkcs8), 'decrypt_failed');
  });
});

describe('recovery codes', () => {
  it('has 8 groups of 4 from the Crockford alphabet, 160 bits', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(recoveryCodeToSecret(code).length).toBe(20);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it('normalizes case, spacing, dashes and look-alike letters', () => {
    const code = generateRecoveryCode();
    const secret = Array.from(recoveryCodeToSecret(code));
    const sloppy = code.toLowerCase().replace(/-/g, ' ');
    expect(Array.from(recoveryCodeToSecret(sloppy))).toEqual(secret);
    expect(Array.from(recoveryCodeToSecret(code.replace(/-/g, '')))).toEqual(secret);
    expect(Array.from(recoveryCodeToSecret(`  ${code}  `))).toEqual(secret);
    // O -> 0, I/L -> 1
    const withZeroOne = '0000-1111-0000-1111-0000-1111-0000-1111';
    expect(Array.from(recoveryCodeToSecret('OOOO-IIII-oooo-llll-0000-1111-0000-1111'))).toEqual(Array.from(recoveryCodeToSecret(withZeroOne)));
  });

  it('rejects wrong lengths and invalid characters', () => {
    const code = generateRecoveryCode();
    expect(() => recoveryCodeToSecret(code.slice(0, -1))).toThrow(CryptoError);
    expect(() => recoveryCodeToSecret(code + 'A')).toThrow(CryptoError);
    expect(() => recoveryCodeToSecret('UUUU-UUUU-UUUU-UUUU-UUUU-UUUU-UUUU-UUUU')).toThrow(CryptoError);
    try {
      recoveryCodeToSecret('nope');
    } catch (e) {
      expect((e as CryptoError).code).toBe('invalid_recovery_code');
    }
  });

  it('encodes known bytes deterministically (base32 sanity)', () => {
    // 20 zero bytes -> 32 zeros; all-0xff -> 32 'Z's.
    expect(Array.from(recoveryCodeToSecret('0'.repeat(32)))).toEqual(new Array(20).fill(0));
    expect(Array.from(recoveryCodeToSecret('Z'.repeat(32)))).toEqual(new Array(20).fill(255));
  });
});
