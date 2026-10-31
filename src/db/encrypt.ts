/**
 * The ONLY place the Connector track calls src/crypto. The Worker encrypts with the current
 * space key and never holds a private key.
 */
import { encryptForKey } from '../crypto/index.ts';
import { getCurrentKey } from './spaces.ts';

export class NoSpaceKeyError extends Error {
  constructor() {
    super('This space has no encryption key yet. Finish setup in the dashboard first.');
    this.name = 'NoSpaceKeyError';
  }
}

export interface Encrypted {
  /** Envelope JSON text, ready for a *_enc column. */
  enc: string;
  keyId: string;
}

export async function encryptCurrent(db: D1Database, plaintext: string): Promise<Encrypted> {
  const key = await getCurrentKey(db);
  if (!key) throw new NoSpaceKeyError();
  const envelope = await encryptForKey(key.id, key.publicKey, plaintext);
  return { enc: JSON.stringify(envelope), keyId: key.id };
}
