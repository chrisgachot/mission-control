/**
 * /api/auth/* (Security track). Contract: docs/ARCHITECTURE.md §3 "Passkeys and unlock", §7.
 *
 *   POST /register/options  { handle, inviteId? }               -> { challengeId, options }
 *   POST /register/verify   { challengeId, handle, inviteId?, response } -> { user, prfEnabled, credentialId } + cookie
 *   POST /login/options     {}                                  -> { challengeId, options }
 *   POST /login/verify      { challengeId, response }           -> { user, prfEnabled, credentialId, wrapped } + cookie
 *   POST /logout            {}                                  -> { ok: true }
 *   GET  /me                                                    -> { user | null }
 *
 * Who may register:
 *   (a) anyone, only while the users table is empty: the first person on a fresh deployment becomes
 *       'owner' (SPACE_KIND personal) or 'admin' (shared). Enforced atomically in SQL at verify time.
 *   (b) on a shared space, the holder of a valid invite id (unclaimed, unexpired, for the current key);
 *       role comes from the invite. The invite is claimed in the same transaction that creates the user.
 * Challenges are single-use (deleted on first verify attempt, success or not) and expire after 5 minutes.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import type { Role, WrappedKey } from '../types.ts';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  countUsers,
  getInvite,
  getCurrentSpaceKey,
  insertChallenge,
  consumeChallenge,
  purgeExpiredChallenges,
  registerUser,
  getCredential,
  getActiveUser,
  updateCredentialAfterLogin,
  listWrappedForUser,
  type InviteRow,
} from '../auth/db.ts';
import { relyingParty, registrationOptions, verifyRegistration, authenticationOptions, verifyLogin, CHALLENGE_TTL_MS } from '../auth/webauthn.ts';
import { newSessionValue, setSessionCookie, startSession, endSession } from '../auth/sessions.ts';
import { fail, parseBody, logEvent, handleSchema, credentialIdSchema } from '../auth/http.ts';
import { validateWrappedKey } from '../crypto/index.ts';

export const router = new Hono<AppEnv>();

/** Loose structural check of a WebAuthn JSON response; simplewebauthn does the real verification. */
const webauthnResponseSchema = z.looseObject({
  id: credentialIdSchema,
  rawId: credentialIdSchema,
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: z.string().max(8192) }),
  clientExtensionResults: z.looseObject({}).optional().default({}),
});

const inviteIdSchema = z.uuid();

/**
 * An invite usable for registration: exists, unclaimed, unexpired, wraps the space's current key, on a
 * shared space, with a role we accept. Returns the role or null.
 */
async function usableInviteRole(env: AppEnv['Bindings'], invite: InviteRow | null, now: number): Promise<Role | null> {
  if (!invite || env.SPACE_KIND !== 'shared') return null;
  if (invite.claimed_by !== null || invite.expires_at <= now) return null;
  const current = await getCurrentSpaceKey(env.DB);
  if (!current || current.id !== invite.key_id) return null;
  return invite.role === 'member' || invite.role === 'admin' ? invite.role : null;
}

function firstUserRole(env: AppEnv['Bindings']): Role {
  return env.SPACE_KIND === 'personal' ? 'owner' : 'admin';
}

// ------------------------------------------------------------------ registration

router.post('/register/options', async (c) => {
  const body = await parseBody(c, z.object({ handle: handleSchema, inviteId: inviteIdSchema.optional() }));
  if (!body.ok) return body.res;
  const db = c.env.DB;
  const now = Date.now();
  await purgeExpiredChallenges(db, now);

  if (body.data.inviteId) {
    const role = await usableInviteRole(c.env, await getInvite(db, body.data.inviteId), now);
    if (!role) return fail(c, 403, 'invite_invalid', 'This invite link is not valid any more. Ask for a new one.');
  } else if ((await countUsers(db)) > 0) {
    return fail(c, 403, 'registration_closed', 'This space already has an owner. Use your passkey to unlock, or ask for an invite.');
  }

  // The future users.id is chosen now so the passkey's user.id (userHandle) equals it.
  const userId = crypto.randomUUID();
  const options = await registrationOptions({ rp: relyingParty(c), rpName: c.env.SPACE_NAME, userId, handle: body.data.handle });
  const challengeId = crypto.randomUUID();
  await insertChallenge(db, { id: challengeId, kind: 'register', userId, challenge: options.challenge, expiresAt: now + CHALLENGE_TTL_MS });
  return c.json({ challengeId, options });
});

router.post('/register/verify', async (c) => {
  const body = await parseBody(
    c,
    z.object({ challengeId: z.uuid(), handle: handleSchema, inviteId: inviteIdSchema.optional(), response: webauthnResponseSchema }),
  );
  if (!body.ok) return body.res;
  const db = c.env.DB;
  const now = Date.now();

  // Burn the challenge first so it cannot be retried, whatever happens next.
  const ch = await consumeChallenge(db, body.data.challengeId, 'register');
  if (!ch || ch.expires_at <= now || !ch.user_id) {
    return fail(c, 400, 'challenge_invalid', 'That passkey prompt expired. Try again.');
  }

  const inviteId = body.data.inviteId ?? null;
  let role: Role;
  if (inviteId) {
    const r = await usableInviteRole(c.env, await getInvite(db, inviteId), now);
    if (!r) return fail(c, 403, 'invite_invalid', 'This invite link is not valid any more. Ask for a new one.');
    role = r;
  } else {
    role = firstUserRole(c.env);
  }

  let verified;
  try {
    verified = await verifyRegistration({
      rp: relyingParty(c),
      expectedChallenge: ch.challenge,
      response: body.data.response as unknown as RegistrationResponseJSON,
    });
  } catch {
    logEvent(c, 'auth.register.verify_failed');
    return fail(c, 400, 'webauthn_failed', 'The passkey could not be verified. Try again.');
  }

  const session = await newSessionValue(now);
  let created: boolean;
  try {
    created = await registerUser(db, {
      userId: ch.user_id,
      handle: body.data.handle,
      role,
      now,
      credential: { id: verified.credentialId, publicKey: verified.publicKey, counter: verified.counter, transports: verified.transports, prfSupported: verified.prfSupported },
      session: { idHash: session.idHash, expiresAt: session.expiresAt },
      inviteId,
    });
  } catch {
    // Most likely a duplicate credential id (UNIQUE/PK). The batch rolled back as a whole.
    logEvent(c, 'auth.register.insert_failed');
    return fail(c, 409, 'registration_failed', 'This passkey is already registered here.');
  }
  if (!created) {
    return inviteId
      ? fail(c, 403, 'invite_invalid', 'This invite link was just used. Ask for a new one.')
      : fail(c, 403, 'registration_closed', 'This space already has an owner.');
  }

  setSessionCookie(c, session.value);
  logEvent(c, 'auth.register.ok', { userId: ch.user_id, role, prf: verified.prfSupported, invite: inviteId !== null });
  return c.json({
    user: { id: ch.user_id, handle: body.data.handle, role },
    prfEnabled: verified.prfSupported,
    credentialId: verified.credentialId,
  });
});

// ------------------------------------------------------------------ login

router.post('/login/options', async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  await purgeExpiredChallenges(db, now);
  const options = await authenticationOptions({ rp: relyingParty(c) });
  const challengeId = crypto.randomUUID();
  await insertChallenge(db, { id: challengeId, kind: 'login', userId: null, challenge: options.challenge, expiresAt: now + CHALLENGE_TTL_MS });
  return c.json({ challengeId, options });
});

router.post('/login/verify', async (c) => {
  const body = await parseBody(c, z.object({ challengeId: z.uuid(), response: webauthnResponseSchema }));
  if (!body.ok) return body.res;
  const db = c.env.DB;
  const now = Date.now();

  const ch = await consumeChallenge(db, body.data.challengeId, 'login');
  if (!ch || ch.expires_at <= now) return fail(c, 400, 'challenge_invalid', 'That passkey prompt expired. Try again.');

  // One message for "unknown credential", "removed user" and "bad signature": do not tell a caller which.
  const notRecognized = () => fail(c, 401, 'passkey_not_recognized', 'That passkey is not registered here.');

  const cred = await getCredential(db, body.data.response.id);
  if (!cred) return notRecognized();
  const user = await getActiveUser(db, cred.user_id);
  if (!user) return notRecognized();

  let v;
  try {
    v = await verifyLogin({
      rp: relyingParty(c),
      expectedChallenge: ch.challenge,
      response: body.data.response as unknown as AuthenticationResponseJSON,
      credential: cred,
    });
  } catch {
    logEvent(c, 'auth.login.verify_failed', { credentialOwner: cred.user_id });
    return notRecognized();
  }

  await updateCredentialAfterLogin(db, cred.id, v.newCounter, now, v.prfSeen);
  await startSession(c, user.id, now);

  // Everything this user needs to unlock in one round trip. PRF wraps are filtered to the passkey just
  // used (another passkey's PRF output cannot open them anyway). Malformed rows are skipped, not fatal.
  const rows = await listWrappedForUser(db, user.id);
  const wrapped: WrappedKey[] = [];
  for (const r of rows) {
    if (r.wrap_kind === 'prf' && r.credential_id !== cred.id) continue;
    try {
      wrapped.push(validateWrappedKey(JSON.parse(r.wrapped)));
    } catch {
      logEvent(c, 'keys.wrapped_row_invalid', { rowId: r.id });
    }
  }

  logEvent(c, 'auth.login.ok', { userId: user.id });
  return c.json({
    user: { id: user.id, handle: user.handle, role: user.role },
    prfEnabled: cred.prf_supported === 1 || v.prfSeen,
    credentialId: cred.id,
    wrapped,
  });
});

// ------------------------------------------------------------------ logout / me

router.post('/logout', async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

router.get('/me', (c) => c.json({ user: c.get('user') }));
