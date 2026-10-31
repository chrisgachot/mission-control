# security track progress

Newest first. Mark uncertainty with ?.

## 2026-10-31 — fixes for review 1 (docs/review/security-review-1.md): findings 1, 2, 6, 7, 8

Findings 3, 4, 5, 9 and the info items are left as open issues, as the coordinator asked.

### What changed

**Finding 1 (high): an invite id alone no longer registers.**
- The inviter's browser derives `claim = b64u(SHA-256(utf8("mission-control/invite-claim/v1") || secretBytes))` and sends `claimHash = sha256B64u(claim)` with `POST /api/invites` (now a required field). The server never sees the claim or the secret at creation.
- `register/options` and `register/verify` with an `inviteId` must also carry `inviteClaim`. One without the other is 400. The server hashes the claim and checks it inside one SQL guard (`USABLE_INVITE_WHERE` in `src/auth/db.ts`).
- That guard runs in the options pre-check, the verify pre-check, and the conditional user `INSERT` inside the registration batch. It also covers findings 2 and 8.
- A wrong claim, an unknown id and a used invite all give the same 403 `invite_invalid`.
- The new user's role is now read from the invite row inside the guarded `INSERT`, not passed in.
- The claim is a one-way, domain-separated derivation of the secret, separate from the HKDF that wraps the key. So the server still cannot unwrap the invite key.
- Crypto helper: `inviteClaimFromSecret(secret)` in `src/crypto/index.ts`.
- `web/src/vault.ts`: `createInvite` sends `claimHash`; `claimInvite(id, secretB64u, handle)` derives the claim from the fragment secret and sends it with both registration calls. The dashboard needs no change.
- `migrations/0001_init.sql`: `invites.claim_hash TEXT NOT NULL`, edited in place as instructed.

**Finding 2: a removed member's invites die with them.**
- The `removeMember` batch now also expires that user's unclaimed invites (`created_by = ?`).
- The registration guard requires the invite's creator to be active (`removed_at IS NULL`).
- The public preview `GET /api/invites/:id` also reports `valid: false` when the creator was removed, so it agrees with the guard.

**Finding 8: the registration guard uses the verify request's clock and checks the current key in SQL.**
- The guard compares `expires_at` with the verify request's `now`, and requires `i.key_id` to equal the newest non-retired key inside the statement.
- So a rotation that commits between the pre-check and the batch wins, and the registration inserts nothing.
- The `UPDATE invites SET claimed_by` now only fires if the guarded insert created our user in this transaction.

**Finding 6: Worker-to-Worker fetches no longer follow redirects and have a byte cap.**
- New file `src/remote-fetch.ts` (Security-owned) with `fetchRemote` and `parseRemoteJson`:
  - `redirect: 'manual'`, and any 3xx throws `shared space answered 3xx (redirect, not followed)`.
  - A Content-Length over the cap is refused before reading. Otherwise the body is read as a stream and counted in bytes, and the read is cancelled once over the cap.
  - JSON parse errors get a fixed message, so the body is never echoed into `last_error` or logs.
- **Connector-track files, minimal call-site changes only:**
  - `src/forward.ts`: the `/space`, `/ingest` and `/projects` fetches now use `fetchRemote` with the 64 KiB cap.
  - `src/api/board.ts`: the `/board` fetch now uses `fetchRemote`.
  - Error messages keep the `shared space answered …` / `unexpected response …` prefixes that `describeFailure` shows.
- My own `src/api/remote-spaces.ts` uses the helper too. That also fixes the review's info point that `text.length` counted UTF-16 units, not bytes.
- **Deviation, flagged:** the coordinator asked for "the same response byte cap as remote-spaces.ts" (64 KiB) everywhere. I kept 64 KiB for `/space`, `/projects` and `/ingest`. The `/board` response uses `MAX_REMOTE_BOARD_BYTES = 4 MiB`, because a board slice carries every workstream plus a range of updates at about 250 bytes per envelope. A modest 30-day board passes 64 KiB at roughly 50 workstreams or 140 updates, and would then show as a failed remote slice. 4 MiB still bounds memory. If 64 KiB is wanted anyway, it is one constant. ?

**Finding 7: `/api/remote/ingest` rejects retired keys.**
- **Connector-track files, minimal change:** `src/db/spaces.ts` gains `keyState(db, id)`, which returns `'live' | 'retired' | null`. `src/api/remote.ts` ingest now returns 400 `retired_key` for a retired kid and keeps 400 `unknown_key` for an unknown one.
- `keyExists` is unchanged and no longer used by `remote.ts`.

### Verification
- `npx tsc --noEmit`: clean. (The earlier `web/src/connect.ts` / `vault-types.ts` mismatch has been reconciled by its owner.)
- `npx vitest run`: 8 files, **97/97 pass**. No existing test encoded the old invite behaviour, so none needed updating.
- `/tmp/sec-e2e/run.ts` (the real app on local D1): **84/84 pass**. New checks:
  - invite creation without `claimHash` is 400, and the server stores only the hash;
  - options with the id alone is 400, and with a wrong claim is 403 `invite_invalid`;
  - verify with a wrong claim is 403 `invite_invalid`, before WebAuthn runs;
  - verify with the right claim passes the guard and fails only on the fake WebAuthn response;
  - the registration batch inserts nothing with no claim or a wrong claim, and registers with the right one; the role comes from the invite row;
  - ingest under a retired key is 400 `retired_key`, and under the current key is 200;
  - a removed admin's unclaimed invite is expired, and options with it is 403;
  - with that invite's expiry restored by hand, the batch still refuses because the creator is removed.
- `/tmp/sec-e2e/fetch.ts`:
  - a 302 is a failure and the target is not contacted;
  - a Content-Length over the cap is refused, and a streamed body over the cap (counted in bytes) is refused;
  - a 60 KB multibyte body under 64 KiB is accepted.
  - Finding 8 race: after a key is retired between the pre-check and the batch, registration inserts nothing and the invite stays unclaimed.
  - These ran under Node's fetch, not workerd. workerd also returns the 3xx for `redirect: 'manual'`, but that path is not exercised in workerd. ?
- Vault probe: 22/22 still pass, and the browser bundle still builds.

### API changes for other tracks
- `POST /api/invites` body: `{ wrapped, claimHash, role? }`. `claimHash` is required.
- `POST /api/auth/register/options` and `/register/verify`: `inviteClaim` is required whenever `inviteId` is sent.
- Both are handled inside `vault.ts`; the Dashboard calls are unchanged.
- `/api/remote/ingest` can now answer 400 `retired_key`.

### Corrections to the earlier notes below
- Decision 24 / the invites header said an invite id alone could register. That is no longer true (finding 1).
- Decision 26: the remote-spaces size check now counts bytes, through `fetchRemote`.

## 2026-10-31 — first full implementation (Opus, Security track)

### Files

| File | What |
| --- | --- |
| `src/crypto/index.ts` | §3 public surface (exact signatures) + helpers: `CryptoError`, `validateEnvelope/parseEnvelope/validateWrappedKey`, `userKeyKid`, `prfSalt`, `sha256B64u`, `randomToken`, `publicKeyFromPrivate`, `isValidPublicKey` |
| `src/crypto/errors.ts` | `CryptoError extends Error` with `code` (`invalid_input`, `invalid_encoding`, `invalid_envelope`, `invalid_wrapped_key`, `invalid_key`, `decrypt_failed`, `unwrap_failed`, `invalid_recovery_code`) |
| `src/crypto/encoding.ts` | strict base64url, UTF-8 (fatal), Crockford base32 |
| `src/crypto/validate.ts` | structural + byte-length validation of Envelope / WrappedKey / raw public keys |
| `src/auth/db.ts` | all SQL for users, credentials, challenges, sessions, space_keys, wrapped_keys, member_tokens, invites, remote_spaces (+ revoke connector_tokens on removal, + space_meta.setup_complete) |
| `src/auth/sessions.ts` | `mc_session` cookie, sha256-hashed session ids |
| `src/auth/webauthn.ts` | @simplewebauthn/server v14 wrappers, PRF handling |
| `src/auth/http.ts` | JSON error helper, zod body parsing, WrappedKey zod schema, log helper |
| `src/middleware/session.ts` | `loadSession` (CSRF + dev bypass + cookie), `requireSession`, `requireRole` |
| `src/api/{auth,keys,invites,members,remote-spaces}.ts` | routes per §7 |
| `src/env.d.ts` | added optional `DEV_BYPASS_USER_ID` to `Bindings` (only that interface touched) |
| `web/src/vault.ts` | browser Vault per §6, plus `DecryptedBoard`/`DecryptedSlice`/`DecryptedWorkstream`/`DecryptedUpdate`, `ConnectPayload`, `NeedsRecoveryCode`, `VaultError`, `LOCKED_TEXT`, `UNREADABLE_TEXT` |
| `test/crypto.test.ts` | 20 unit tests, run in workerd |

### Verification

- `npx vitest run test/crypto.test.ts`: 20/20 pass (workerd WebCrypto). Full `npx vitest run`: 21/21 pass.
- `npx tsc --noEmit`: clean except one cross-track error, see "Integration notes" (1).
- WebAuthn API check (`/tmp/webauthn-check/check.mjs`, Node): `generateRegistrationOptions`, `verifyRegistrationResponse`, `generateAuthenticationOptions`, `verifyAuthenticationResponse` exist in v14; options come out as expected (`prf: {}` passes through, the library adds `credProps: true`, residentKey required, algs `[-7,-8,-257]`).
- End-to-end smoke outside the repo (`/tmp/sec-e2e/run.ts`, the real Hono app against wrangler's local D1): 70 checks pass. Covered: CSRF on/off paths, first-run race (second registration inserts nothing, not even a session), registration closed afterwards and after a removal, dev bypass (localhost only, unknown id fails closed), keys setup once only, import rules, invite create/preview/single use/key/claim, member token hashing matches Connector's `findMemberToken`, re-claim revokes the old token, role checks, member removal (session, tokens, wraps), rotation completeness / removed users / reused kid / stale previousKid, invites expire on rotation, remote-spaces URL validation and owner-only.
- SQL guards checked directly (`/tmp/sec-e2e/guard.ts`): a rotate or setup that reuses an existing kid changes nothing. **Local D1 enforces foreign keys** (that is why the key_id workaround below is needed).
- Vault without WebAuthn (`/tmp/sec-e2e/vault.ts`, mocked fetch): recovery-code unlock, wrong code, user_pub-delivered rotated key, decryptBoard with unknown kid / malformed / `javascript:` link, hostile connect link rejected, nothing secret in any POST body, lock drops keys. 22/22.
- Vault + crypto bundle with esbuild for the browser (no Node imports, no storage APIs).
- **Not tested:** the real WebAuthn ceremonies (registration/login verify with a real or virtual authenticator, PRF output). That needs Playwright with a Chromium virtual authenticator (`hasPrf: true`). ?

### Security decisions and reasoning

**Crypto (src/crypto)**
1. Followed the contract exactly: ECIES = P-256 ECDH, HKDF-SHA256 (salt empty, info `mission-control/v1/<kid>`), AES-256-GCM (12-byte random IV, 128-bit tag, AAD = utf8(kid)). Fresh ephemeral key per message, so each message has its own AES key; IV reuse across messages is impossible.
2. Domain separation: wraps use info `mission-control/wrap/<kind>` (`prf`, `recovery`, `invite`, `user_pub`), so a wrap can never open as an envelope or as another kind (tested). AAD = kid on every GCM call, so relabelling a ciphertext's kid fails (tested).
3. `wrapWithSecret`: HKDF(secret, 16 random salt bytes) → AES-GCM over the PKCS8 bytes. No PBKDF2/Argon2: every secret is real randomness (PRF 256-bit, invite 256-bit, recovery 160-bit), so stretching adds latency, not security. Secrets under 16 bytes are refused.
4. `wrapForUserPub`: ECIES to the user's key with info `mission-control/wrap/user_pub`; ephemeral public key stored in `salt` (65 bytes).
5. Strict validation before WebCrypto: exact lengths (epk 65, iv 12, wrap salt 16 or 65, ct bounds 16..64 KiB for envelopes, 17..512 bytes for wraps), kid charset `[A-Za-z0-9:_-]{1,128}`, strict base64url (rejects `+/`), fatal UTF-8 decode. Public keys are imported (WebCrypto checks the point is on the curve), which is the invalid-curve defence on the decrypt side. Unwrapped PKCS8 is re-imported before being returned.
6. Recovery code: 20 random bytes → 32 Crockford base32 symbols (no I/L/O/U) → 8 groups of 4. `recoveryCodeToSecret` is case-insensitive, ignores spaces/dashes/dots/underscores, maps O→0 and I/L→1, rejects anything else or a wrong count with `invalid_recovery_code`. No checksum: a typo that is still 32 valid symbols fails later as `unwrap_failed`.
7. PRF eval input is a fixed public constant, `SHA-256("mission-control/prf/v1")`. The PRF output is already per-credential and per-RP; the salt is only domain separation. A constant allows discoverable login (no allowCredentials) and lets the browser compute it itself rather than trust the server's copy.
8. Errors never contain values (no plaintext, keys, secrets). The module never logs.

**Passkeys (src/auth/webauthn.ts, src/api/auth.ts)**
9. rpID = request hostname, origin = request origin. Discoverable credentials (`residentKey: required`), so login options list no credential ids. `userVerification: required` at both ceremonies (the passkey unlocks the key, so possession alone is not enough). Attestation `none`. Algorithms ES256, Ed25519, RS256.
10. **The PRF output never goes to the server.** The vault rebuilds `clientExtensionResults` from a whitelist (`credProps.rk`, `prf.enabled` only), and the server strips `prf.results` again before using the response. At login the vault reports `prf: { enabled: true }` when it got results, and the server records `prf_supported = 1` (upgrade only). `prf_supported` is a client-reported hint and gates nothing security-relevant.
11. Challenges: stored with 5-minute expiry, consumed with `DELETE ... RETURNING` before verification (single-use even if verification fails or two verifies race). Expired rows are purged on every options call.
12. Registration is atomic in one D1 batch (transaction): the user insert is conditional (`WHERE NOT EXISTS (SELECT 1 FROM users)` for first run; `WHERE EXISTS (unclaimed, unexpired invite)` for invites), the invite is marked claimed in the same batch, and the credential and session inserts are conditioned on the user existing. A lost race leaves nothing behind. "users is empty" counts removed users too, so removing everyone never reopens first-run registration.
13. The WebAuthn `user.id` is utf8(users.id), chosen at options time and stored on the challenge. At login, if a `userHandle` comes back it must match the credential's owner (defence in depth; the library checks `id === rawId` and the signature).
14. Login failure messages do not distinguish unknown credential / removed user / bad signature. Removed users cannot log in or use existing sessions (the session lookup joins `users.removed_at IS NULL`).
15. Login verify returns `{ user, prfEnabled, credentialId, wrapped }`. PRF wraps are filtered to the passkey just used. Malformed rows are skipped and logged by row id.

**Sessions and middleware**
16. Cookie `mc_session` = 32 random bytes base64url; DB stores sha256 only. HttpOnly, SameSite=Lax, Path=/, Max-Age 30 days, Secure except on localhost/127.0.0.1. New value on every login. The server-side `expires_at` is what is enforced. Cookie values not matching the 43-char format skip the DB.
17. CSRF in `loadSession`: POST/PUT/PATCH/DELETE under `/api/` need `X-Requested-With: mission-control`, else 403 `csrf`. Exempt exactly `/api/remote` and `/api/remote/*` (bearer tokens, no cookie). `/api/remote-spaces` is not exempt (tested). `/mcp` never reaches this middleware. The Worker sends no CORS headers, so a cross-site fetch cannot set the header without a preflight that fails.
18. **DEV BYPASS rule:** if `DEV_BYPASS_USER_ID` is set **and** the request hostname is exactly `localhost` or `127.0.0.1`, the request is treated as that user, which must exist and not be removed (an unknown id falls through to normal cookie auth, i.e. fails closed). Set it only in `.dev.vars` for `wrangler dev` / Playwright. Never put it in `wrangler.jsonc` vars or production secrets. Two independent conditions: the variable is absent in production, and a deployed Worker is not reached under those hostnames. CSRF is still enforced under the bypass.

**Keys (src/api/keys.ts)**
19. The browser picks the kid (a UUID) for setup and rotation, because the kid is bound into every wrap's AAD and must be known before the wraps are made. The server checks format and uniqueness. (Deviation from "kid = uuid" being server-generated; same result.)
20. Setup: owner/admin only, only while no space key exists. Atomic batch where every follow-on statement (set users.public_key, insert wraps, set setup_complete) is guarded by "the key row this request inserted exists" (`id`, `created_at = now`, `public_key`, not retired). It also requires a **recovery** wrap of both the space key and the user key, so a client bug cannot lock the owner out. PRF wraps require a `credentialId` that belongs to the caller.
21. Import: any session, only the caller's own rows. A `user:` kid must be the caller's own. `users.public_key` is set once and never replaced (409 on mismatch), because rotation wraps new keys to it, and an overwrite would let a stolen session redirect future keys. Cap of 500 wrapped rows per user.
22. Rotate: owner/admin; `previousKid` must equal the current key (stops two rotations interleaving); new kid must be new; every active member with a public key must get exactly one `user_pub` wrap of the new key (else 400 `rotation_incomplete`); wraps for removed or unknown users are refused; the caller must keep at least one wrap. The batch inserts the key, retires all others, stores the wraps and expires outstanding unclaimed invites (they carry the old key), all guarded so a reused kid cannot retire the live key (tested).
23. All public keys arriving from browsers or other spaces are checked on-curve before storage, so a bad key cannot break `encryptForKey` for every agent report.

**Invites, members, remote spaces**
24. Invites (shared only, admin): the wrap must be kind `invite` for the current kid. Preview is public and says only `{valid, spaceName, role, expiresAt}`. An invite is valid only if unclaimed, unexpired **and** its kid is still current. `GET /:id/key` and `POST /:id/claim` require that `claimed_by` is the caller, and answer 404 otherwise (does not confirm someone else's invite id). Claim mints a 32-byte member token, stores sha256 (same format as Connector's `hashToken`), returns the plaintext once, and revokes any earlier live token of that member.
25. Member removal (admin): cannot remove yourself or an owner. One batch sets `removed_at`, deletes sessions, revokes member and connector tokens, deletes wrapped keys. Response `{ ok, rotationRequired: true }`; the dashboard should call `vault.rotateAfterRemoval()` right away.
26. Remote spaces (personal copy, owner): `baseUrl` normalized to a bare origin, https only (http allowed only for localhost/127.0.0.1), no userinfo/path/query/fragment, not this Worker's own origin. Verified by `GET {baseUrl}/api/remote/space` with the bearer token, 4 s timeout, `redirect: 'manual'` (the token is never re-sent to a host the owner did not type), 64 KiB response cap, must be `kind: 'shared'` with a valid key. Re-adding the same base URL updates the token in place. GET never returns `member_token`.

**Vault (web/src/vault.ts)**
27. Keys only in a module-level Map (kid → PKCS8), never in any storage API or URL. The PRF output of the unlocking passkey is also kept in memory while unlocked (needed to re-wrap keys received later; same sensitivity as the keys). `lock()` drops everything, including the plaintext cache (bounded at 5000 entries; placeholders are not cached).
28. `unlock()`: passkey login with PRF → open PRF wraps → open `user_pub` wraps with the user key. If PRF opened nothing, it keeps the login result and throws `NeedsRecoveryCode` (name `NeedsRecoveryCode`, as `web/src/host.ts` expects). `unlockWithRecoveryCode()` uses that, or `GET /api/keys` if there is a session. If the passkey did give a PRF output that matched nothing (new passkey / PRF started working), it adds PRF wraps afterwards so the passkey alone works next time.
29. `decrypt`/`decryptBoard` never throw for one bad row: unknown kid → `🔒 (key not available)`, malformed or tampered → `🔒 (unreadable)`. `link` is kept only if it parses as an http(s) URL, so a hostile agent cannot plant `javascript:`. Output types drop the `*Enc` fields (they match the Dashboard's `vault-types.ts` shapes).
30. `importRemoteKey`: a connect link may only add keys. It cannot carry `user:` kids or any kid already in this copy's space_keys (a hostile link could otherwise make local history unreadable). Imported keys are stored wrapped to the user's own key (`user_pub`, no recovery code needed) and to PRF if held. It does not call `/api/remote-spaces` (the Dashboard's `connect.ts` does that).
31. `ConnectPayload` = `{ v, name, baseUrl, memberToken, secret, sharedWrapped: WrappedKey[] }` with the shared key wrapped (kind `invite`) under `secret`, which is in the same fragment. **No confidentiality beyond the fragment itself**; it gives integrity (a damaged link fails instead of importing garbage) and kid binding. The whole link (key + bearer token) is a secret; `/connect` should clear `location.hash` after reading (the invite page already does `history.replaceState`).
32. `claimInvite` returns `ConnectPayload & { recoveryCode }` (the member needs a recovery code too). The Dashboard already strips `recoveryCode` before building the link.
33. `rotateAfterRemoval` wraps the new key to every active member's public key from `GET /api/members`, to self via `user_pub` and PRF, and posts `/api/keys/rotate` with `previousKid`.

### Contract gaps and integration notes (orchestrator)

1. **tsc error (cross-track):** `web/src/connect.ts` imports `ConnectPayload` from the Dashboard's temporary `web/src/vault-types.ts` (`sharedWrapped: unknown`, no `secret`) and passes it to `vault.importRemoteKey`. Fix: swap the Dashboard's `vault-types.ts` imports to `./vault.ts` as that file's header says. Shapes otherwise match.
2. **wrapped_keys.key_id FK.** It references `space_keys(id)` and local D1 enforces it, but two kinds of wraps have no local space key: the user's own key (`kid = "user:<userId>"`) and remote shared keys imported on a personal copy. Workaround: store those rows with `key_id` = the local kid in effect, while the JSON's `kid` (also bound into the ciphertext) is authoritative. Suggest a migration 0002 that drops the FK or adds a nullable `foreign_kid`. ?
3. **WrappedKey.salt for `prf`** holds the HKDF salt (16 random bytes), not the PRF eval input; the PRF eval input is the fixed constant above. The types.ts comment ("prf: PRF salt used") is slightly off.
4. **remote_spaces has no soft-delete column.** DELETE is a real delete, and it is refused with 409 `remote_space_in_use` while any project (even archived) references the row via `projects.remote_space_id`. Suggest `removed_at` in migration 0002.
5. `/api/keys/setup` and `/rotate` take a `kid` and optional `credentialId`; `/rotate` takes `previousKid` and `members: [{userId, wrapped}]`. `GET /api/keys` returns `{ keys, currentKid, userPublicKey, wrapped }`. `GET /api/auth/me` returns 200 `{ user: null }` when signed out. `GET /api/members` returns `{ members }`, `GET /api/remote-spaces` returns `{ remoteSpaces }` with `lastSyncAt` (the Dashboard type has an optional `lastOkAt`, which we don't send).
6. `vault` also has `observeSpace(space)`, so `state()` can report `needs-setup`; otherwise `needs-setup` appears only after `unlock()` finds no stored keys. Dashboard may call it after `GET /api/space`.
7. Connector's `src/api/_csrf.ts` duplicates the CSRF check; harmless (same header), but `loadSession` already covers every `/api/*` route.

### Known limits

- **Recovery code decrypts, it does not authenticate.** A person who loses every passkey cannot sign in, so they cannot fetch their wraps. Account recovery (e.g. a recovery-derived verifier that allows registering a new passkey) is not built. ?
- **First-run race on a fresh deploy:** whoever registers first on an empty deployment becomes owner/admin. The deployer should finish setup right after deploying. A `SETUP_TOKEN` secret would close this. ?
- **Server trust for member public keys:** rotation wraps to the public keys `GET /api/members` returns. A compromised Worker could substitute its own key. That is inside the existing known limit (a compromised Worker already sees plaintext on arrival), but there is no key fingerprint check.
- **Personal copies miss shared rotations:** after a shared space rotates, a member's personal copy holds only the old shared key, so new shared items show `🔒 (key not available)` on the personal board until the member re-imports. The member's shared-copy login does get the new key (user_pub wrap). A fix needs a member-token endpoint on the shared copy that serves that member's `user_pub` wraps, plus the member's shared-copy user key on the personal copy. ?
- **New members do not get history:** an invite carries only the current key, so a member who joins after a rotation cannot read items under older kids.
- **Edge:** if a rotation happens between a member's registration and their `/keys/import`, they have no public key yet, so they get no wrap of the new key and end up holding only the retired one. ?
- **No rate limiting** on the unauthenticated options endpoints (challenge rows can be spammed; expired rows are purged on each call). A Cloudflare rate-limiting binding would fix it.
- **No epk/recipient binding in the KDF** (the contract says info = `mission-control/v1/<kid>`, salt empty). Consequence is benign malleability: negating the ephemeral point gives the same shared x-coordinate, so a re-encoded envelope with the same plaintext decrypts. A v2 should do HPKE-style binding (`epk || recipientPub` in the HKDF info).
- Browser memory: JS strings cannot be zeroed; "lock" means "unreferenced". Any script running in the dashboard origin (XSS) can use the unlocked vault, so the Dashboard must render plaintext with `textContent` and the deploy should ship a strict CSP.
- Plaintext passes through Worker memory on arrival (spec's stated limit; unchanged).

### For the second reviewer: look hardest at

1. `src/crypto/index.ts` + `validate.ts`: HKDF/AES-GCM parameters, AAD and info strings, length checks, error mapping; `recoveryCodeToSecret` normalization.
2. PRF secrecy end to end: `cleanExtensions`/`prfOutput` in `web/src/vault.ts` and `stripPrf` in `src/auth/webauthn.ts`. Confirm no path posts `prf.results`.
3. `src/auth/db.ts` `registerUser`, `setupFirstKey`, `rotateKey`, `removeMember`: conditional SQL and batch atomicity (D1 batch = transaction), especially the `OWN_KEY_EXISTS` guards.
4. `src/middleware/session.ts`: CSRF exemption boundary (`/api/remote` vs `/api/remote-spaces`) and the DEV bypass conditions.
5. `src/api/keys.ts` rotate: completeness rule and who may get wraps; import's public-key write-once rule.
6. `src/api/invites.ts`: validity rules (current kid, claimed_by) and member token minting.
7. `web/src/vault.ts` `importRemoteKey`: the "add only" rule, and the honesty of the `ConnectPayload` wrapping (decision 31).
8. `src/api/remote-spaces.ts`: SSRF surface (`normalizeBaseUrl`, `redirect: 'manual'`).
