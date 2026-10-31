/**
 * Type re-exports from the vault, kept so the board modules have one place to import plaintext shapes from.
 * The Security track's web/src/vault.ts owns the definitions.
 */
export type { DecryptedBoard, DecryptedSlice, DecryptedUpdate, DecryptedWorkstream, ConnectPayload } from './vault.ts';
