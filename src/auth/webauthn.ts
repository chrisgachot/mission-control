/**
 * Passkeys (Security track), on @simplewebauthn/server v14 (pure WebCrypto, runs on Workers).
 * Contract: docs/ARCHITECTURE.md §3 "Passkeys and unlock".
 *
 * Decisions:
 * - RP id = the request hostname and expected origin = the request origin. Each deployment is its own
 *   relying party; a passkey made for one Worker cannot be replayed against another. On Cloudflare the
 *   request URL's host is the host Cloudflare routed on, so a client cannot pick a different RP id.
 * - residentKey 'required' (discoverable credentials): login options carry no allowCredentials, so the
 *   unauthenticated login endpoint never lists credential ids or reveals who is registered.
 * - userVerification 'required' at both registration and login: a passkey here unlocks the encryption
 *   key, so "something you have" alone (a security key without PIN) is not enough.
 * - attestation 'none': we do not need to know the authenticator model, and asking would only add
 *   privacy cost and failure modes.
 * - Algorithms: ES256 first (every passkey provider supports it), then Ed25519, then RS256 (Windows Hello).
 * - PRF: registration requests `prf: {}` so the client reports whether PRF is available; login requests
 *   `prf: { eval: { first: SHA-256("mission-control/prf/v1") } }` (see prfSalt in src/crypto). The PRF
 *   OUTPUT is the wrapping secret for the user's keys: the browser must never send it to the server. The
 *   vault strips `prf.results` before posting, and this module strips it again defensively before the
 *   response object is used, so it is never stored or logged even if a client misbehaves.
 * - prf_supported is a client-reported hint (client extension outputs are not signed by the
 *   authenticator). It only decides whether the browser tries PRF first; lying about it gains nothing,
 *   because the server never holds anything that PRF unlocks.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { Context } from 'hono';
import type { AppEnv } from '../env.d.ts';
import { b64u, unb64u, prfSalt } from '../crypto/index.ts';
import type { CredentialRow } from './db.ts';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Shown to the browser as the passkey prompt timeout; slightly under the server-side challenge TTL. */
const CEREMONY_TIMEOUT_MS = 4 * 60 * 1000;

/** COSE algorithm ids: ES256 (-7), EdDSA (-8), RS256 (-257). */
const SUPPORTED_ALGS = [-7, -8, -257];

export interface RelyingParty {
  rpID: string;
  origin: string;
}

export function relyingParty(c: Context<AppEnv>): RelyingParty {
  const u = new URL(c.req.url);
  return { rpID: u.hostname, origin: u.origin };
}

const textEncoder = new TextEncoder();

/** WebAuthn user.id bytes for a Mission Control user id (utf8 of the uuid). Returned as userHandle at login. */
export function webauthnUserId(userId: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(userId) as Uint8Array<ArrayBuffer>;
}

/**
 * Remove any PRF results from client extension outputs before we touch the response. Returns whether
 * the client reported PRF as enabled / produced (see vault: on login it sends `prf: { enabled: true }`
 * in place of the results it stripped).
 */
function stripPrf(resp: { clientExtensionResults?: unknown }): boolean {
  const ext = resp.clientExtensionResults;
  if (typeof ext !== 'object' || ext === null) {
    resp.clientExtensionResults = {};
    return false;
  }
  const prf = (ext as Record<string, unknown>).prf;
  let enabled = false;
  if (typeof prf === 'object' && prf !== null) {
    const p = prf as Record<string, unknown>;
    enabled = p.enabled === true || p.results !== undefined;
    delete p.results;
  }
  return enabled;
}

export async function registrationOptions(a: {
  rp: RelyingParty;
  rpName: string;
  userId: string;
  handle: string;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: a.rpName,
    rpID: a.rp.rpID,
    userName: a.handle,
    userDisplayName: a.handle,
    userID: webauthnUserId(a.userId),
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    supportedAlgorithmIDs: SUPPORTED_ALGS,
    extensions: { prf: {} },
  });
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string; // COSE, base64url
  counter: number;
  transports: string | null; // JSON array
  prfSupported: boolean;
}

/** Throws on any verification failure (simplewebauthn throws descriptive Errors; callers map to 400). */
export async function verifyRegistration(a: {
  rp: RelyingParty;
  expectedChallenge: string;
  response: RegistrationResponseJSON;
}): Promise<VerifiedRegistration> {
  const prfSupported = stripPrf(a.response as unknown as { clientExtensionResults?: unknown });
  const v = await verifyRegistrationResponse({
    response: a.response,
    expectedChallenge: a.expectedChallenge,
    expectedOrigin: a.rp.origin,
    expectedRPID: a.rp.rpID,
    requireUserVerification: true,
    supportedAlgorithmIDs: SUPPORTED_ALGS,
  });
  if (!v.verified) throw new Error('registration not verified');
  const cred = v.registrationInfo.credential;
  const transports = Array.isArray(cred.transports) ? JSON.stringify(cred.transports.filter((t) => typeof t === 'string').slice(0, 8)) : null;
  return { credentialId: cred.id, publicKey: b64u(cred.publicKey), counter: cred.counter, transports, prfSupported };
}

export async function authenticationOptions(a: { rp: RelyingParty }): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const opts = await generateAuthenticationOptions({
    rpID: a.rp.rpID,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: 'required',
    // allowCredentials omitted on purpose: discoverable login, nothing about users is revealed.
  });
  // The PRF eval input travels as base64url, the WebAuthn L3 JSON convention (the same thing
  // PublicKeyCredential.parseRequestOptionsFromJSON expects). The simplewebauthn type says BufferSource
  // because it describes the decoded form; the vault decodes it (and in fact recomputes it locally
  // rather than trusting this copy).
  const first = b64u(await prfSalt());
  opts.extensions = { ...(opts.extensions ?? {}), prf: { eval: { first: first as unknown as BufferSource } } };
  return opts;
}

export interface VerifiedLogin {
  newCounter: number;
  prfSeen: boolean;
}

/** Throws on any verification failure. */
export async function verifyLogin(a: {
  rp: RelyingParty;
  expectedChallenge: string;
  response: AuthenticationResponseJSON;
  credential: CredentialRow;
}): Promise<VerifiedLogin> {
  const prfSeen = stripPrf(a.response as unknown as { clientExtensionResults?: unknown });

  // Defence in depth: if the authenticator returned a userHandle, it must be the user who owns this
  // credential id. (We look the credential up by id, so a mismatch means a confused or hostile client.)
  const uh = a.response.response.userHandle;
  if (uh !== undefined && uh !== null && uh !== '') {
    let handleBytes: Uint8Array;
    try {
      handleBytes = unb64u(uh);
    } catch {
      throw new Error('userHandle is not base64url');
    }
    if (new TextDecoder().decode(handleBytes) !== a.credential.user_id) throw new Error('userHandle does not match credential owner');
  }

  let transports: string[] | undefined;
  try {
    const t: unknown = a.credential.transports ? JSON.parse(a.credential.transports) : undefined;
    transports = Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : undefined;
  } catch {
    transports = undefined;
  }

  const v = await verifyAuthenticationResponse({
    response: a.response,
    expectedChallenge: a.expectedChallenge,
    expectedOrigin: a.rp.origin,
    expectedRPID: a.rp.rpID,
    requireUserVerification: true,
    credential: {
      id: a.credential.id,
      publicKey: unb64u(a.credential.public_key),
      counter: a.credential.counter,
      ...(transports ? { transports } : {}),
    },
  });
  if (!v.verified) throw new Error('authentication not verified');
  return { newCounter: v.authenticationInfo.newCounter, prfSeen };
}
