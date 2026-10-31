/**
 * Typed errors for the crypto module.
 *
 * Every failure inside src/crypto is thrown as a CryptoError with a stable `code`, so callers
 * (Worker routes, the browser vault) can branch on the reason without parsing messages.
 * Messages never contain key material, plaintext or secrets: only which check failed.
 */

export type CryptoErrorCode =
  /** A caller-supplied argument has the wrong shape (bad kid, empty secret, non-string, ...). */
  | 'invalid_input'
  /** A base64url string contains characters outside the URL-safe alphabet or has an impossible length. */
  | 'invalid_encoding'
  /** An Envelope object (or its JSON) is malformed: wrong version, missing field, wrong byte length. */
  | 'invalid_envelope'
  /** A WrappedKey object is malformed. */
  | 'invalid_wrapped_key'
  /** A public or private key could not be imported as a P-256 ECDH key. */
  | 'invalid_key'
  /** AES-GCM authentication failed while opening an Envelope (tampered, wrong key, wrong kid). */
  | 'decrypt_failed'
  /** AES-GCM authentication failed while unwrapping a private key (wrong secret, tampered, wrong kid). */
  | 'unwrap_failed'
  /** A recovery code does not normalize to exactly 32 valid symbols. */
  | 'invalid_recovery_code';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

export function isCryptoError(e: unknown): e is CryptoError {
  return e instanceof CryptoError;
}
