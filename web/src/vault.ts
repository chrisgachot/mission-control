/**
 * The browser vault (Security track). Contract: docs/ARCHITECTURE.md §6 (interface) and §3 (flows).
 *
 * The vault is the only place in the dashboard that touches private keys or produces plaintext.
 *
 * What it holds, and where:
 *   - Private keys (space keys by kid, the user's own key under "user:<id>", shared-space keys imported
 *     from /connect): in a Map in this module's memory, as PKCS8 base64url strings. Never in
 *     localStorage, sessionStorage, IndexedDB, cookies or the URL. Reloading the tab or lock() drops them.
 *   - The PRF output of the passkey used to unlock: also in memory while unlocked, because re-wrapping a
 *     newly received key (rotation, /connect import) needs it. It is exactly as sensitive as the keys it
 *     unwraps, so holding it alongside them adds no exposure. Dropped by lock().
 *   - Decrypted strings: a bounded in-memory cache so 30-second board polls do not redo ECDH for every
 *     row. Dropped by lock().
 *
 * What it never does:
 *   - Send the PRF output, a recovery code, an invite secret or any private key to a server. WebAuthn
 *     responses are rebuilt from a whitelist before posting (see cleanExtensions), so PRF results cannot
 *     leak even if a browser adds fields.
 *   - Touch the DOM. Flows that need the person mid-way return data (setup() returns the recovery code;
 *     unlock() throws NeedsRecoveryCode) and the Dashboard track owns the UI.
 *
 * Known limits (also in docs/progress/security.md): JS strings cannot be zeroed, so "dropped" means
 * "unreferenced"; any script running in this origin (XSS) can call the vault while it is unlocked, so the
 * dashboard must render plaintext with textContent and keep a strict CSP.
 */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { BoardResponse, BoardSlice, Role, UpdateRow, WorkstreamRow, WrappedKey, SpaceInfo } from '../../src/types.ts';
import {
  b64u,
  unb64u,
  randomBytes,
  generateSpaceKeyPair,
  generateUserKeyPair,
  decryptEnvelope,
  parseEnvelope,
  wrapWithSecret,
  unwrapWithSecret,
  wrapForUserPub,
  unwrapWithUserPriv,
  generateRecoveryCode,
  recoveryCodeToSecret,
  prfSalt,
  publicKeyFromPrivate,
  userKeyKid,
  validateWrappedKey,
  USER_KID_PREFIX,
  CryptoError,
} from '../../src/crypto/index.ts';
import { ApiError } from './api.ts';

// ====================================================================== public types

export interface DecryptedUpdate extends Omit<UpdateRow, 'bodyEnc'> {
  body: string | null;
}

export interface DecryptedWorkstream extends Omit<WorkstreamRow, 'titleEnc' | 'linkEnc' | 'latestUpdate'> {
  title: string;
  /** Only http(s) URLs survive; anything else (javascript:, data:, unreadable) becomes null. */
  link: string | null;
  latestUpdate: DecryptedUpdate | null;
}

export interface DecryptedSlice extends Omit<BoardSlice, 'workstreams' | 'updates'> {
  workstreams: DecryptedWorkstream[];
  updates: DecryptedUpdate[];
}

export interface DecryptedBoard extends Omit<BoardResponse, 'local' | 'remote'> {
  local: DecryptedSlice;
  remote: DecryptedSlice[];
}

/**
 * What a shared space hands a member so their personal copy can store it. Travels in the fragment of
 * `https://<personal>/connect#<b64u(JSON)>` (fragments are never sent to servers).
 *
 * sharedWrapped holds the shared space key(s) wrapped (kind 'invite') under `secret`, which travels in
 * the same fragment. Be clear about what that buys: NO confidentiality beyond the fragment itself (anyone
 * with the whole link has the key, exactly like an invite link). It gives integrity (a truncated or
 * altered link fails AES-GCM instead of importing a garbage key) and binds each key to its kid. The
 * memberToken in the same link is a bearer credential too. Treat the link as a secret; the /connect page
 * should clear location.hash as soon as it has read it.
 */
export interface ConnectPayload {
  v?: 1;
  name: string;
  baseUrl: string;
  memberToken: string;
  secret: string;
  sharedWrapped: WrappedKey[];
}

/** Thrown by unlock() when the passkey gave no PRF output that opens a key: ask for the recovery code. */
export class NeedsRecoveryCode extends Error {
  constructor() {
    super('This passkey cannot unlock the keys by itself. Enter your recovery code.');
    this.name = 'NeedsRecoveryCode';
  }
}

export type VaultErrorCode =
  | 'locked'
  | 'no_session'
  | 'wrong_recovery_code'
  | 'invite_invalid'
  | 'invite_secret_wrong'
  | 'bad_connect_link'
  | 'key_not_available'
  | 'not_allowed';

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

export interface Vault {
  state(): 'locked' | 'unlocked' | 'needs-setup';
  setup(handle: string): Promise<{ recoveryCode: string }>;
  unlock(): Promise<void>;
  unlockWithRecoveryCode(code: string): Promise<void>;
  lock(): void;
  decrypt(envJson: string | null): Promise<string | null>;
  decryptBoard(b: BoardResponse): Promise<DecryptedBoard>;
  importRemoteKey(payload: ConnectPayload): Promise<void>;
  createInvite(role: Role): Promise<string>;
  /** Returns the connect payload plus the member's new recovery code (show it once; never put it in the link). */
  claimInvite(id: string, secretB64u: string, handle: string): Promise<ConnectPayload & { recoveryCode: string }>;
  rotateAfterRemoval(): Promise<void>;
}

/** Shown in place of text whose key this browser does not hold (e.g. written before you joined). */
export const LOCKED_TEXT = '🔒 (key not available)';
/** Shown in place of a malformed or tampered envelope. */
export const UNREADABLE_TEXT = '🔒 (unreadable)';

// ====================================================================== API plumbing

interface ApiUser {
  id: string;
  handle: string;
  role: Role;
}
interface LoginVerifyResponse {
  user: ApiUser;
  prfEnabled: boolean;
  credentialId: string;
  wrapped: WrappedKey[];
}
interface RegisterVerifyResponse {
  user: ApiUser;
  prfEnabled: boolean;
  credentialId: string;
}
interface KeysResponse {
  keys: { id: string; publicKey: string; createdAt: number; retiredAt: number | null }[];
  currentKid: string | null;
  userPublicKey: string | null;
  wrapped: WrappedKey[];
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'mission-control', Accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

// ====================================================================== WebAuthn helpers

/** Copy the PRF output out of client extension results, if present. */
function prfOutput(ext: unknown): Uint8Array | null {
  const first = (ext as { prf?: { results?: { first?: unknown } } } | undefined)?.prf?.results?.first;
  let out: Uint8Array | null = null;
  if (first instanceof ArrayBuffer) out = new Uint8Array(first.slice(0));
  else if (ArrayBuffer.isView(first)) out = new Uint8Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength));
  // PRF outputs are 32 bytes. Anything shorter is not something we will use as a wrapping secret.
  return out && out.length >= 32 ? out : null;
}

/**
 * Rebuild client extension results from a whitelist before sending them to the server. The PRF output
 * (prf.results) is NEVER included: it is the wrapping secret. We send only `prf.enabled`, set to true at
 * login when results were produced, so the server can record that this passkey supports PRF.
 */
function cleanExtensions(ext: unknown, prfProduced: boolean): Record<string, unknown> {
  const e = (ext ?? {}) as { prf?: { enabled?: unknown }; credProps?: { rk?: unknown } };
  const out: Record<string, unknown> = {};
  if (e.credProps && typeof e.credProps.rk === 'boolean') out.credProps = { rk: e.credProps.rk };
  const enabled = prfProduced || e.prf?.enabled === true;
  if (e.prf !== undefined || prfProduced) out.prf = { enabled };
  return out;
}

async function passkeyRegister(handle: string, inviteId?: string): Promise<RegisterVerifyResponse> {
  const { challengeId, options } = await call<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
    'POST',
    '/api/auth/register/options',
    inviteId ? { handle, inviteId } : { handle },
  );
  const resp: RegistrationResponseJSON = await startRegistration({ optionsJSON: options });
  const response = { ...resp, clientExtensionResults: cleanExtensions(resp.clientExtensionResults, false) };
  return call<RegisterVerifyResponse>('POST', '/api/auth/register/verify', inviteId ? { challengeId, handle, inviteId, response } : { challengeId, handle, response });
}

/** Passkey login with PRF evaluation. Returns the server's unlock bundle and the PRF output (or null). */
async function passkeyLogin(): Promise<{ login: LoginVerifyResponse; prf: Uint8Array | null }> {
  const { challengeId, options } = await call<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('POST', '/api/auth/login/options', {});
  // Use our own copy of the PRF salt rather than the server's: it is a public constant, and computing it
  // here means a tampered server response cannot steer which PRF value the authenticator computes.
  const optionsJSON: PublicKeyCredentialRequestOptionsJSON = {
    ...options,
    extensions: { ...(options.extensions ?? {}), prf: { eval: { first: await prfSalt() } } },
  };
  const resp: AuthenticationResponseJSON = await startAuthentication({ optionsJSON });
  const prf = prfOutput(resp.clientExtensionResults);
  const response = { ...resp, clientExtensionResults: cleanExtensions(resp.clientExtensionResults, prf !== null) };
  const login = await call<LoginVerifyResponse>('POST', '/api/auth/login/verify', { challengeId, response });
  return { login, prf };
}

/** Only http(s) links reach the dashboard, so a hostile agent cannot plant a javascript: URL. */
function safeLink(s: string | null): string | null {
  if (s === null || s === LOCKED_TEXT || s === UNREADABLE_TEXT) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function isUserKid(kid: string): boolean {
  return kid.startsWith(USER_KID_PREFIX);
}

const MAX_CACHE = 5000;

// ====================================================================== implementation

class BrowserVault implements Vault {
  /** kid -> PKCS8 (base64url). Space keys, shared-space keys, and "user:<id>" for our own user key. */
  private keys = new Map<string, string>();
  private userId: string | null = null;
  /** PRF output of the passkey that unlocked us, for re-wrapping keys we receive while unlocked. */
  private prf: { credentialId: string; secret: Uint8Array } | null = null;
  /** Set when unlock() needed the recovery code: what the passkey login returned. */
  private pending: { userId: string; wrapped: WrappedKey[]; prf: { credentialId: string; secret: Uint8Array } | null } | null = null;
  private setupNeeded = false;
  private cache = new Map<string, string>();

  /** Optional: let the vault know the space state, so state() can report 'needs-setup'. */
  observeSpace(space: SpaceInfo): void {
    this.setupNeeded = !space.setupComplete;
  }

  state(): 'locked' | 'unlocked' | 'needs-setup' {
    if ([...this.keys.keys()].some((k) => !isUserKid(k))) return 'unlocked';
    return this.setupNeeded ? 'needs-setup' : 'locked';
  }

  lock(): void {
    this.keys.clear();
    this.cache.clear();
    this.prf = null;
    this.pending = null;
    this.userId = null;
  }

  // -------------------------------------------------------------- unwrapping

  /**
   * Open whatever `wrapped` allows with the given secret(s), then open user_pub wraps with our user key.
   * Individual failures are expected (other passkey's PRF wraps, wrong code) and skipped.
   * Returns the number of non-user keys now held.
   */
  private async absorb(userId: string, wrapped: WrappedKey[], secret: Uint8Array, kind: 'prf' | 'recovery'): Promise<number> {
    for (const raw of wrapped) {
      let w: WrappedKey;
      try {
        w = validateWrappedKey(raw);
      } catch {
        continue;
      }
      if (w.kind !== kind || this.keys.has(w.kid)) continue;
      if (isUserKid(w.kid) && w.kid !== userKeyKid(userId)) continue; // never adopt someone else's "user key"
      try {
        this.keys.set(w.kid, await unwrapWithSecret(w, secret));
      } catch {
        /* not ours / wrong secret */
      }
    }
    const userPriv = this.keys.get(userKeyKid(userId));
    if (userPriv) {
      for (const raw of wrapped) {
        let w: WrappedKey;
        try {
          w = validateWrappedKey(raw);
        } catch {
          continue;
        }
        if (w.kind !== 'user_pub' || this.keys.has(w.kid) || isUserKid(w.kid)) continue;
        try {
          this.keys.set(w.kid, await unwrapWithUserPriv(w, userPriv));
        } catch {
          /* skip */
        }
      }
    }
    this.cache.clear(); // placeholders computed before may now be readable (we never cache placeholders, but be safe)
    return [...this.keys.keys()].filter((k) => !isUserKid(k)).length;
  }

  // -------------------------------------------------------------- unlock

  async unlock(): Promise<void> {
    const { login, prf } = await passkeyLogin();
    this.lock();
    this.userId = login.user.id;
    const prfState = prf ? { credentialId: login.credentialId, secret: prf } : null;
    if (login.wrapped.length === 0) {
      // Signed in, but no keys stored for this person (setup or invite import never finished).
      this.setupNeeded = true;
      return;
    }
    if (prfState && (await this.absorb(login.user.id, login.wrapped, prfState.secret, 'prf')) > 0) {
      this.prf = prfState;
      return;
    }
    this.pending = { userId: login.user.id, wrapped: login.wrapped, prf: prfState };
    throw new NeedsRecoveryCode();
  }

  async unlockWithRecoveryCode(code: string): Promise<void> {
    const secret = recoveryCodeToSecret(code); // throws CryptoError('invalid_recovery_code') on bad format
    let userId: string;
    let wrapped: WrappedKey[];
    let prfState: { credentialId: string; secret: Uint8Array } | null = null;
    if (this.pending) {
      ({ userId, wrapped, prf: prfState } = this.pending);
    } else {
      // A session must exist: the recovery code decrypts keys, it does not log anyone in.
      const me = await call<{ user: ApiUser | null }>('GET', '/api/auth/me');
      if (!me.user) throw new VaultError('no_session', 'Sign in with your passkey first.');
      userId = me.user.id;
      wrapped = (await call<KeysResponse>('GET', '/api/keys')).wrapped;
    }
    this.keys.clear();
    this.cache.clear();
    this.userId = userId;
    if ((await this.absorb(userId, wrapped, secret, 'recovery')) === 0) {
      this.keys.clear();
      throw new VaultError('wrong_recovery_code', 'That recovery code does not open this space.');
    }
    this.pending = null;

    // The passkey did produce a PRF output but none of our PRF wraps matched it (e.g. a newly added
    // passkey, or PRF started working): wrap what we now hold with it, so next time the passkey alone works.
    if (prfState) {
      this.prf = prfState;
      try {
        await this.storeWraps(await this.prfWrapsOf([...this.keys.keys()]));
      } catch {
        /* best effort: unlocking still succeeded */
      }
    }
  }

  // -------------------------------------------------------------- re-wrapping helpers

  private async prfWrapsOf(kids: string[]): Promise<WrappedKey[]> {
    if (!this.prf) return [];
    const out: WrappedKey[] = [];
    for (const kid of kids) {
      const priv = this.keys.get(kid);
      if (priv) out.push(await wrapWithSecret('prf', kid, priv, this.prf.secret));
    }
    return out;
  }

  private async storeWraps(wrapped: WrappedKey[], userPublicKey?: string): Promise<void> {
    if (wrapped.length === 0 && !userPublicKey) return;
    const hasPrf = wrapped.some((w) => w.kind === 'prf');
    await call('POST', '/api/keys/import', {
      wrapped,
      ...(userPublicKey ? { userPublicKey } : {}),
      ...(hasPrf && this.prf ? { credentialId: this.prf.credentialId } : {}),
    });
  }

  private requireUnlocked(): string {
    if (this.state() !== 'unlocked' || !this.userId) throw new VaultError('locked', 'Unlock Mission Control first.');
    return this.userId;
  }

  private async ownUserPublicKey(userId: string, fromServer: string | null): Promise<string | null> {
    if (fromServer) return fromServer;
    const priv = this.keys.get(userKeyKid(userId));
    return priv ? publicKeyFromPrivate(priv) : null;
  }

  // -------------------------------------------------------------- first run

  async setup(handle: string): Promise<{ recoveryCode: string }> {
    let user: ApiUser | null = (await call<{ user: ApiUser | null }>('GET', '/api/auth/me')).user;
    let prf: { credentialId: string; secret: Uint8Array } | null = null;

    if (!user) {
      try {
        const reg = await passkeyRegister(handle);
        user = reg.user;
        if (reg.prfEnabled) {
          // A second passkey prompt: PRF output is only available from get(), not from create() with `prf: {}`.
          const { login, prf: out } = await passkeyLogin();
          if (out) prf = { credentialId: login.credentialId, secret: out };
        }
      } catch (e) {
        // The owner registered earlier but key setup never finished (tab closed). Sign in and continue.
        if (!(e instanceof ApiError && e.code === 'registration_closed')) throw e;
        const { login, prf: out } = await passkeyLogin();
        user = login.user;
        if (out) prf = { credentialId: login.credentialId, secret: out };
      }
    } else {
      // Already signed in (same situation, cookie still valid). We still need a passkey prompt for PRF.
      const { login, prf: out } = await passkeyLogin();
      user = login.user;
      if (out) prf = { credentialId: login.credentialId, secret: out };
    }
    if (user.role !== 'owner' && user.role !== 'admin') throw new VaultError('not_allowed', 'Only the owner or admin sets up the space key.');

    const kid = crypto.randomUUID();
    const ukid = userKeyKid(user.id);
    const space = await generateSpaceKeyPair();
    const mine = await generateUserKeyPair();
    const recoveryCode = generateRecoveryCode();
    const rsecret = recoveryCodeToSecret(recoveryCode);

    const wrapped: WrappedKey[] = [
      await wrapWithSecret('recovery', kid, space.privateKeyPkcs8, rsecret),
      await wrapWithSecret('recovery', ukid, mine.privateKeyPkcs8, rsecret),
    ];
    if (prf) {
      wrapped.push(await wrapWithSecret('prf', kid, space.privateKeyPkcs8, prf.secret));
      wrapped.push(await wrapWithSecret('prf', ukid, mine.privateKeyPkcs8, prf.secret));
    }
    await call('POST', '/api/keys/setup', {
      kid,
      spacePublicKey: space.publicKeyRaw,
      userPublicKey: mine.publicKeyRaw,
      ...(prf ? { credentialId: prf.credentialId } : {}),
      wrapped,
    });

    this.lock();
    this.userId = user.id;
    this.keys.set(kid, space.privateKeyPkcs8);
    this.keys.set(ukid, mine.privateKeyPkcs8);
    this.prf = prf;
    this.setupNeeded = false;
    return { recoveryCode };
  }

  // -------------------------------------------------------------- decrypt

  async decrypt(envJson: string | null): Promise<string | null> {
    if (envJson === null || envJson === undefined) return null;
    const hit = this.cache.get(envJson);
    if (hit !== undefined) return hit;
    let env;
    try {
      env = parseEnvelope(envJson);
    } catch {
      return UNREADABLE_TEXT;
    }
    const priv = this.keys.get(env.kid);
    if (!priv || isUserKid(env.kid)) return LOCKED_TEXT; // placeholders are not cached: the key may arrive later
    try {
      const text = await decryptEnvelope(env, priv);
      if (this.cache.size >= MAX_CACHE) this.cache.clear();
      this.cache.set(envJson, text);
      return text;
    } catch {
      return UNREADABLE_TEXT;
    }
  }

  private async decryptUpdate(u: UpdateRow): Promise<DecryptedUpdate> {
    const { bodyEnc, ...rest } = u;
    return { ...rest, body: await this.decrypt(bodyEnc) };
  }

  private async decryptSlice(s: BoardSlice): Promise<DecryptedSlice> {
    const { workstreams, updates, ...rest } = s;
    const ws = await Promise.all(
      workstreams.map(async (w): Promise<DecryptedWorkstream> => {
        const { titleEnc, linkEnc, latestUpdate, ...wrest } = w;
        const [title, link, latest] = await Promise.all([
          this.decrypt(titleEnc),
          this.decrypt(linkEnc),
          latestUpdate ? this.decryptUpdate(latestUpdate) : Promise.resolve(null),
        ]);
        return { ...wrest, title: title ?? '', link: safeLink(link), latestUpdate: latest };
      }),
    );
    const ups = await Promise.all(updates.map((u) => this.decryptUpdate(u)));
    return { ...rest, workstreams: ws, updates: ups };
  }

  /** Never throws for a bad row: each field falls back to LOCKED_TEXT / UNREADABLE_TEXT on its own. */
  async decryptBoard(b: BoardResponse): Promise<DecryptedBoard> {
    const { local, remote, ...rest } = b;
    const [l, r] = await Promise.all([this.decryptSlice(local), Promise.all(remote.map((s) => this.decryptSlice(s)))]);
    return { ...rest, local: l, remote: r };
  }

  // -------------------------------------------------------------- shared spaces

  async createInvite(role: Role): Promise<string> {
    this.requireUnlocked();
    if (role === 'owner') throw new VaultError('not_allowed', 'Invites are for members or admins.');
    const { currentKid } = await call<KeysResponse>('GET', '/api/keys');
    const priv = currentKid ? this.keys.get(currentKid) : undefined;
    if (!currentKid || !priv) throw new VaultError('key_not_available', 'This browser does not hold the current space key.');
    const secret = randomBytes(32);
    const wrapped = await wrapWithSecret('invite', currentKid, priv, secret);
    const { id } = await call<{ id: string }>('POST', '/api/invites', { wrapped, role });
    // The secret goes only into the fragment, which browsers never send to servers.
    return `${globalThis.location.origin}/invite/${encodeURIComponent(id)}#${b64u(secret)}`;
  }

  async claimInvite(id: string, secretB64u: string, handle: string): Promise<ConnectPayload & { recoveryCode: string }> {
    let inviteSecret: Uint8Array;
    try {
      inviteSecret = unb64u(secretB64u);
    } catch {
      throw new VaultError('invite_secret_wrong', 'This invite link is incomplete. Ask for a new one.');
    }
    if (inviteSecret.length < 32) throw new VaultError('invite_secret_wrong', 'This invite link is incomplete. Ask for a new one.');
    const preview = await call<{ valid: boolean }>('GET', `/api/invites/${encodeURIComponent(id)}`);
    if (!preview.valid) throw new VaultError('invite_invalid', 'This invite link is not valid any more. Ask for a new one.');

    const reg = await passkeyRegister(handle, id);
    let prf: { credentialId: string; secret: Uint8Array } | null = null;
    if (reg.prfEnabled) {
      const { login, prf: out } = await passkeyLogin();
      if (out) prf = { credentialId: login.credentialId, secret: out };
    }

    const { wrapped: inviteWrap } = await call<{ wrapped: WrappedKey }>('GET', `/api/invites/${encodeURIComponent(id)}/key`);
    let spacePriv: string;
    try {
      spacePriv = await unwrapWithSecret(inviteWrap, inviteSecret);
    } catch {
      throw new VaultError('invite_secret_wrong', 'This invite link does not match its key. Ask for a new one.');
    }
    const kid = inviteWrap.kid;
    const ukid = userKeyKid(reg.user.id);
    const mine = await generateUserKeyPair();
    const recoveryCode = generateRecoveryCode();
    const rsecret = recoveryCodeToSecret(recoveryCode);

    const wrapped: WrappedKey[] = [
      await wrapWithSecret('recovery', kid, spacePriv, rsecret),
      await wrapWithSecret('recovery', ukid, mine.privateKeyPkcs8, rsecret),
    ];
    if (prf) {
      wrapped.push(await wrapWithSecret('prf', kid, spacePriv, prf.secret));
      wrapped.push(await wrapWithSecret('prf', ukid, mine.privateKeyPkcs8, prf.secret));
    }
    await call('POST', '/api/keys/import', {
      wrapped,
      userPublicKey: mine.publicKeyRaw,
      ...(prf ? { credentialId: prf.credentialId } : {}),
    });
    const claim = await call<{ memberToken: string; spaceName: string; baseUrl: string }>('POST', `/api/invites/${encodeURIComponent(id)}/claim`, {});

    this.lock();
    this.userId = reg.user.id;
    this.keys.set(kid, spacePriv);
    this.keys.set(ukid, mine.privateKeyPkcs8);
    this.prf = prf;
    this.setupNeeded = false;

    const connectSecret = randomBytes(32);
    return {
      v: 1,
      name: claim.spaceName,
      baseUrl: claim.baseUrl,
      memberToken: claim.memberToken,
      secret: b64u(connectSecret),
      sharedWrapped: [await wrapWithSecret('invite', kid, spacePriv, connectSecret)],
      recoveryCode,
    };
  }

  async importRemoteKey(payload: ConnectPayload): Promise<void> {
    const userId = this.requireUnlocked();
    if (!payload || typeof payload.secret !== 'string' || !Array.isArray(payload.sharedWrapped) || payload.sharedWrapped.length === 0) {
      throw new VaultError('bad_connect_link', 'That is not a complete Mission Control connect link.');
    }
    let secret: Uint8Array;
    try {
      secret = unb64u(payload.secret);
    } catch {
      throw new VaultError('bad_connect_link', 'That connect link is damaged.');
    }
    const keysInfo = await call<KeysResponse>('GET', '/api/keys');
    const localKids = new Set(keysInfo.keys.map((k) => k.id));
    const imported: { kid: string; priv: string }[] = [];
    for (const raw of payload.sharedWrapped) {
      let w: WrappedKey;
      try {
        w = validateWrappedKey(raw);
      } catch {
        throw new VaultError('bad_connect_link', 'That connect link is damaged.');
      }
      // A connect link may only ADD keys. It must not replace one of this copy's own keys or our user key
      // (a hostile link could otherwise make local history unreadable in this browser).
      if (w.kind !== 'invite' || isUserKid(w.kid) || localKids.has(w.kid)) {
        throw new VaultError('bad_connect_link', 'That connect link carries a key this copy will not accept.');
      }
      try {
        imported.push({ kid: w.kid, priv: await unwrapWithSecret(w, secret) });
      } catch {
        throw new VaultError('bad_connect_link', 'That connect link is damaged.');
      }
    }
    // Store each shared key wrapped to our own user key (so any future unlock, by passkey or recovery code,
    // recovers it without needing the recovery code now) and to our PRF (so the passkey alone opens it).
    const ownPub = await this.ownUserPublicKey(userId, keysInfo.userPublicKey);
    const wrapped: WrappedKey[] = [];
    for (const k of imported) {
      if (this.keys.has(k.kid)) continue; // already held (re-import)
      if (ownPub) wrapped.push(await wrapForUserPub(k.kid, k.priv, ownPub));
      if (this.prf) wrapped.push(await wrapWithSecret('prf', k.kid, k.priv, this.prf.secret));
    }
    if (wrapped.length === 0 && imported.some((k) => !this.keys.has(k.kid))) {
      throw new VaultError('key_not_available', 'Could not store the shared key: this account has no user key.');
    }
    await this.storeWraps(wrapped);
    for (const k of imported) this.keys.set(k.kid, k.priv);
    this.cache.clear();
  }

  async rotateAfterRemoval(): Promise<void> {
    const userId = this.requireUnlocked();
    const keysInfo = await call<KeysResponse>('GET', '/api/keys');
    if (!keysInfo.currentKid) throw new VaultError('key_not_available', 'This space has no key yet.');
    const { members } = await call<{ members: { id: string; publicKey: string | null }[] }>('GET', '/api/members');
    const ownPub = await this.ownUserPublicKey(userId, keysInfo.userPublicKey);

    const kid = crypto.randomUUID();
    const next = await generateSpaceKeyPair();
    const self: WrappedKey[] = [];
    // To self: wrapped to our user key (recoverable with the recovery code via the user key) and to PRF.
    if (ownPub) self.push(await wrapForUserPub(kid, next.privateKeyPkcs8, ownPub));
    if (this.prf) self.push(await wrapWithSecret('prf', kid, next.privateKeyPkcs8, this.prf.secret));
    if (self.length === 0) throw new VaultError('key_not_available', 'Cannot keep a copy of the new key for you; not rotating.');

    const memberWraps: { userId: string; wrapped: WrappedKey }[] = [];
    for (const m of members) {
      if (m.id === userId || !m.publicKey) continue;
      memberWraps.push({ userId: m.id, wrapped: await wrapForUserPub(kid, next.privateKeyPkcs8, m.publicKey) });
    }
    await call('POST', '/api/keys/rotate', {
      kid,
      previousKid: keysInfo.currentKid,
      publicKey: next.publicKeyRaw,
      ...(this.prf ? { credentialId: this.prf.credentialId } : {}),
      wrapped: self,
      members: memberWraps,
    });
    this.keys.set(kid, next.privateKeyPkcs8);
  }
}

export const vault: Vault & { observeSpace(space: SpaceInfo): void } = new BrowserVault();

/** Re-exported so dashboard code can branch on crypto failures without importing src/crypto itself. */
export { CryptoError };
