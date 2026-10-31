# Security review 1: encryption and authentication

Second, independent review of the Security track (crypto, passkeys, sessions, keys, invites, members, remote spaces, browser vault) against docs/ARCHITECTURE.md §3. No source files were changed.

Verification run: `npx tsc --noEmit` is clean. `npx vitest run` passes 95/95. Throwaway probes are in `/tmp/rev1/`:
- `mall.ts` (Node WebCrypto) checks ECIES malleability, base64url canonicality, off-curve epk, wrap-kind relabelling, and recovery-code normalization.
- `paths.ts` runs the real `loadSession` inside a Hono app shaped like the real one and checks the CSRF boundary against odd paths.

## Findings, ranked

### 1. HIGH: the invite id alone is enough to join; the secret is not needed

**Where:** `src/api/auth.ts:59-65`, `80-82`, `112-115`; `src/auth/db.ts:150-153`; `src/api/keys.ts:114-167`, `203-216`; `web/src/vault.ts:680-695`

**What is wrong:** Registering with `inviteId` only checks that the invite exists, is unclaimed, unexpired and on the current kid. Nothing checks that the person registering holds the fragment secret. The module header says "Possession of the invite id alone lets someone register ... but not read anything". The first half is true, and it leads to read access later.

The id is the URL path (`/invite/<id>`, `GET /api/invites/<id>`). The fragment is not. So the id ends up in places the secret does not:
- Workers Logs: `observability.enabled: true` in `wrangler.jsonc` records request URLs.
- Link unfurlers in Slack, iMessage and Teams, which fetch the path without the fragment.
- Synced browser history and proxy logs.

**Scenarios:**
- **(a) Member invite, read access.** The attacker sees the id in logs and registers first, choosing the expected handle (e.g. "Sam").
  - They call `POST /api/invites/<id>/claim` and get a member token. With it they read plaintext project names and all board metadata, and can ingest items onto the shared board (anyone can encrypt to the public key).
  - They call `POST /api/keys/import` with any well-formed `recovery` wrap of their own `user:<id>` key, plus `userPublicKey`. Nothing proves they hold a space key.
  - The next time any admin rotates (for example after removing someone), `/api/keys/rotate` requires a `user_pub` wrap for every active member with a public key. It returns `rotation_incomplete` otherwise. So the admin's vault is forced to wrap the new space key to the attacker.
  - From then on the attacker reads everything. The real invitee only sees "invite was just used" and asks for a new link.
- **(b) Admin invite, takeover.** The impostor becomes `admin`.
  - `GET /api/members` gives them every id. `DELETE /api/members/<creatorId>` succeeds, because only `owner` is protected and the creator of a shared space is `admin`.
  - They can remove every legitimate user. Registration never reopens (`countUsers` counts removed users), so the space is permanently taken over.

**Minimal fix:** require proof of the secret when registering with an invite.
- At `createInvite`, derive `inviteAuth = HKDF(secret, info="mission-control/invite-auth")`. Send `SHA-256(inviteAuth)` with `POST /api/invites` and store it in a new column.
- `register/options` and `register/verify` take `inviteAuth`. The server compares hashes (a hash lookup, so there is no timing issue), and the conditional `INSERT` in `registerUser` also checks it.
- Add defence in depth for scenario (a): an admin should confirm new members before rotation wraps to them. Rotation should only require keys of confirmed members.

### 2. MEDIUM: removing an admin does not revoke invites they created

**Where:** `src/auth/db.ts:374-383` (`removeMember`); `src/api/auth.ts:59-65` (`usableInviteRole`)

**What is wrong:** `removeMember` revokes sessions, member tokens, connector tokens and wraps. It does not touch `invites`. `usableInviteRole` does not check that `invites.created_by` is still active. The only thing that expires invites is `rotateKey`, which the admin's browser runs after the DELETE, best-effort (see 4).

**Scenario:**
- Admin B expects to be removed and makes an invite link first (it can be role `admin`). B keeps the secret.
- After `DELETE /api/members/B`, B registers a new passkey with the link before rotation runs, or at any time if rotation fails.
- If B gets in before the rotation POST lands and imports a public key, the rotation is forced to wrap the new key to B (same mechanism as 1a).
- B knows exactly when to act, because B's session dies at the moment of removal.

**Minimal fix:**
- In the `removeMember` batch, add `UPDATE invites SET expires_at = ? WHERE claimed_by IS NULL AND expires_at > ?`. Expiring all unclaimed invites is simplest; at minimum expire those `created_by = ?`.
- Also require `created_by` to be active in the `registerUser` invite `INSERT ... WHERE EXISTS`.

### 3. MEDIUM: public keys are not authenticated anywhere, so key substitution yields plaintext

**Where:** `src/forward.ts:44-56`; `src/auth/db.ts:216-220` / `src/db/spaces.ts:78-82`; `web/src/vault.ts:680-695`

**What is wrong:**
- On every agent write to a shared project, the personal Worker fetches `/api/remote/space` and encrypts to whatever `publicKey`/`keyId` comes back. There is no pinning, and the key is not compared to the shared key the member's vault holds.
- Locally, the Worker encrypts to the newest non-retired `space_keys` row. Nothing authenticates that row.
- Rotation wraps the new private key to whatever `GET /api/members` returns.

The author lists the third point as a known limit, covered by "a compromised Worker sees plaintext anyway". That reasoning does not hold for the first two. Someone who can write to D1 but cannot run code in the Worker (for example a Cloudflare API token with D1 edit, or a restored or edited backup) normally sees only ciphertext.

**Scenarios:**
- **(a) Shared space DB.** Write access to the shared space's D1 only: insert a `space_keys` row with the attacker's public key and a later `created_at`. From then on, every member's personal Worker encrypts its forwarded titles, links and notes to the attacker. None of those personal Workers is compromised.
- **(b) Local DB.** The same insert locally captures every new agent report on that copy.

**Minimal fix:**
- **(i) Pin the shared key at connect time.** The connect payload already carries the kid, and the vault holds the private key, so it can check `publicKeyFromPrivate(priv) == /space.publicKey`. Store the pinned kid and public key in `remote_spaces`. `forwardEvent` then refuses to encrypt to anything else and records `last_error: key changed, re-connect`.
- **(ii) Detect a swapped local key at unlock.** In the vault, check that `GET /api/keys` `currentKid` is held and that its `publicKey` equals `publicKeyFromPrivate(held)`. Warn loudly if not.
- **(iii) Optional.** HMAC the `space_keys` rows with a Worker secret (`wrangler secret`) so a D1-only writer cannot forge them.

### 4. MEDIUM-LOW: rotation after removal is best-effort with no retry, and fails open

**Where:** `web/src/setup.ts:290-299`; `src/api/members.ts:42-49`

**What is wrong:** The DELETE commits first, then `vault.rotateAfterRemoval()` runs. If rotation fails, the UI shows a toast and nothing else. Ways it can fail:
- Network error.
- `stale_key` when two admins act at once.
- `rotation_incomplete`, because a member set their public key between the two GETs.
- The tab closes.

When rotation fails, the old key stays live: new data is readable by the removed person, who already holds it, and unclaimed invites stay valid (see 2). There is no separate "Rotate key" control and no server-side record that a rotation is owed.

**Minimal fix:**
- Set `space_meta.rotation_required = '1'` in the `removeMember` batch and clear it in `rotateKey`.
- The dashboard shows a persistent "Rotate now" banner while it is set.
- `POST /api/invites` refuses while it is set.

### 5. LOW-MEDIUM: envelopes are not bound to their row or field

**Where:** `src/crypto/index.ts:168-177` (AAD = `utf8(kid)` only)

**What is wrong:** A ciphertext can be moved between workstreams, between fields (title/link/body) and between updates, and it still decrypts.

**Scenario:** A malicious shared space, or anyone with D1 write access:
- copies the `body_enc` "approve $214 to vendor X" from one `waiting` item onto another workstream; or
- copies one item's `link_enc` onto another item.

The person approves or clicks believing it belongs to a different item. Confidentiality is not affected.

**Minimal fix (v2 envelope):** AAD = `kid || table || column || row id`. The Worker knows the row id before encrypting. Alternatively, accept this and document it as an integrity limit.

### 6. LOW: Worker-to-Worker fetches follow redirects and have no size cap

**Where:** `src/forward.ts:44`, `69`, `100`; `src/api/board.ts:27-32`

**What is wrong:** `remote-spaces.ts` deliberately uses `redirect: 'manual'` and a 64 KiB cap. The forwarding, project-list and board fetches do neither. They use the default `follow` and unbounded `res.json()`.

**Possible impact:**
- I am not certain whether workerd strips `Authorization` on a cross-origin redirect. If it does not, a 30x from the shared host (misconfigured route, custom domain moved, CDN rule) sends the member token to the redirect target.
- A 307/308 on `/ingest` replays the encrypted body to the target. Its confidentiality depends on the key fetched by the also-redirected `/space` call, which ties into 3.
- An oversized board or project response can exhaust Worker memory for that request.

**Minimal fix:** use `redirect: 'manual'` and treat any 3xx as an error. Read the body with a byte cap, as `remote-spaces.ts` does but counting bytes, not `text.length`.

### 7. LOW: `/api/remote/ingest` accepts retired key ids

**Where:** `src/api/remote.ts:91`, `src/db/spaces.ts:85-87` (`keyExists` ignores `retired_at`)

**What is wrong:** A forward that fetched `/space` just before a rotation, or a buggy or malicious member client, can keep writing new data under the retired key. A removed member who later obtains ciphertext (a backup, a remaining member's mirror) can read it.

**Minimal fix:** require `retired_at IS NULL`, or `retired_at > now - 60s` as a grace window.

### 8. LOW: invite registration races a concurrent rotation

**Where:** `src/api/auth.ts:63` (JS-side current-kid check); `src/auth/db.ts:151` (`expires_at > r.now`)

**What is wrong:** `rotateKey` sets `expires_at = rotationNow`. A registration whose `now` was taken earlier still passes `expires_at > r.now`, and the current-kid check is not in SQL. The new member then holds only the retired key. This adds to the author's "rotation between register and import" edge case, and rotation silently skips members without a public key.

**Minimal fix:** add `AND key_id = (SELECT id FROM space_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1)` to the conditional user `INSERT`.

### 9. LOW: no CSP, and private keys sit in memory as extractable PKCS8 strings

**Where:** `public/index.html` (no CSP meta) and no `public/_headers`; `web/src/vault.ts:273`

**What is wrong:** The vault's own header says the deploy "should ship a strict CSP". There is none. The dashboard builds almost all UI with `innerHTML`. Every decrypted field I sampled goes through `esc()` and links go through `safeLink`/`safeUrl`, so I found no XSS. But a single escaping slip in the Dashboard track would let injected script read every private key directly from the Map.

**Minimal fix:**
- Add `public/_headers` with `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`.
- Optionally, keep a non-extractable `CryptoKey` for decryption and the PKCS8 copy only where re-wrapping needs it.

### 10. LOW: bearer secrets and invite ids appear in request URLs, which are logged

**Where:** `ALL /mcp/:token` (`src/mcp/router.ts`); `/invite/<id>`; `wrangler.jsonc` `observability.enabled: true`

**What is wrong:** Workers Logs record request URLs, so the connector token (full agent write access) and invite ids (see 1) are persisted. Anyone with log read access, or any Logpush sink, can see them.

**Minimal fix:**
- Also accept `Authorization: Bearer` on `/mcp` and document that form as preferred where clients support it.
- Document the log exposure.
- Fix 1 so a leaked invite id is harmless.

### 11. INFO: ECIES benign malleability (confirmed)

**Where:** `src/crypto/index.ts:174`, `185`

**What is wrong:** Replacing `epk` (x, y) with (x, p−y) gives the same ECDH x-coordinate, so a different envelope string decrypts to the same plaintext. `/tmp/rev1/mall.ts` prints `negated epk differs: true -> decrypts to: secret title`.

**Real impact:**
- Envelopes are not unique, so the vault's cache key (`envJson`) and any ciphertext-equality dedup can be fooled.
- No plaintext is forged and nothing leaks: the AES key, IV and ct are unchanged, so there is no key+IV reuse with different plaintexts.

**Fix (v2):** HKDF info = `prefix || kid || epk || recipientPub` (HPKE-style).

### 12. INFO: `unb64u` accepts non-canonical base64url, contrary to its comment

**Where:** `src/crypto/encoding.ts:28-45`

**What is wrong:**
- `atob` discards non-zero trailing bits, so flipping the low bit of the last `epk` character still decodes to the same bytes (confirmed: `non-canonical epk string accepted`).
- Any number of trailing `=` is also accepted (`'AAAA===='` decodes).

The comment claims "two different strings, same bytes" is impossible. The impact is the same as 11.

**Fix:** after decoding, require `b64u(out) === body`.

### 13. INFO: a hostile connect link can replace an already-held shared key in memory

**Where:** `web/src/vault.ts:672`

**What is wrong:** The store step skips kids already held (line 664), but the final loop overwrites them in memory anyway. A link carrying an existing shared kid with a different private key makes that slice unreadable until reload. The effect is limited to the current session and changes no stored state.

**Fix:** `if (!this.keys.has(k.kid)) this.keys.set(...)`.

### 14. INFO: `normalizeBaseUrl` loosenesses

**Where:** `src/api/remote-spaces.ts:57`, `103-104`

**What is wrong:**
- `http://localhost` / `http://127.0.0.1` are allowed in production as well, which means sending the bearer token over plaintext HTTP. It is harmless only because a deployed Worker cannot reach localhost.
- IP literals and any port are allowed. Workers cannot reach private networks or metadata endpoints, so the SSRF surface is small, and the route is owner-only.
- The body is fully read before the size check, and `text.length` counts UTF-16 units, not bytes.

**Fix:** allow http-localhost only when the Worker's own hostname is local. Read the body with a byte cap.

### 15. INFO: DEV_BYPASS is sound in production, with one local-dev caveat

**Where:** `src/middleware/session.ts:54-55`

**Production:** I found no way for the bypass to apply. The variable is only in gitignored `.dev.vars`, `wrangler deploy` does not upload it, `scripts/deploy.mjs` does not touch it, and Cloudflare does not route `Host: localhost`.

**Local dev caveat:** the bypass needs no cookie. So while `wrangler dev` runs, any web page the developer visits can make blind no-cors GETs to `http://localhost:8787/api/...` as the bypass user. POSTs are still blocked by the CSRF header. If dev is bound to `0.0.0.0`, a LAN client sending `Host: localhost` also gets the bypass. DNS rebinding does not work, because the hostname check sees the attacker's name.

**Optional hardening:** also require `APP_VERSION === 'dev'`.

### 16. INFO: any admin can remove any other admin, including the space creator

**Where:** `src/api/members.ts:40`

**What is wrong:** On a shared space the creator is `admin`, the same role an admin invite grants, so there is no protected creator. This is a design choice, but it makes 1(b) and 2 worse.

**Option:** give the creator an un-removable role, or require that at least one creator-designated admin remains.

### 17. INFO: errors are logged with `err.message` verbatim

**Where:** `src/index.ts:26`, `src/mcp/tools.ts:55`

**What is wrong:** I found no path where plaintext reaches these messages. Crypto errors carry no values, and D1 constraint errors name columns, not values. But V8 `SyntaxError` messages from `JSON.parse` include an excerpt of the input. If an unguarded `c.req.json()` were ever added on a plaintext path, titles would end up in logs.

**Option:** log `err.name` plus a fixed code instead.

## Checked and found correct

- **Envelope parameters:** HKDF salt (empty) and info (`mission-control/v1/<kid>`), and the GCM AAD (`utf8(kid)`), are identical in encrypt and decrypt.
- **Kid binding:** the kid is bound twice (HKDF info and AAD). Relabelling fails, and is covered by a test.
- **Ephemeral key validation:** `epk` is validated as 65 bytes with a 0x04 prefix, then imported, so an off-curve point is rejected with `invalid_key` (tested in workerd, and confirmed in Node).
- **IV:** always `randomBytes(12)`, and every envelope and wrap uses a fresh key (fresh ephemeral key, or a fresh 16-byte HKDF salt). I found no way for two different plaintexts to share a key and IV.
- **Wrap domain separation:**
  - `info = mission-control/wrap/<kind>`. Relabelling an invite wrap as recovery or prf fails, and an envelope does not open as a `user_pub` wrap (confirmed).
  - The kind is validated server-side, and stored wraps are limited to prf/recovery/user_pub.
- **Recovery code:**
  - 20 CSPRNG bytes, giving 32 Crockford symbols and 160 bits. All 32 symbols occur.
  - Normalization accepts exactly 32 symbols. A truncated code is rejected, and U is rejected.
  - Unicode case-mapping oddities (`ß` becomes `SS`) only produce a wrong secret, which then fails to unwrap.
- **Unwrapped key check:** the unwrapped PKCS8 is re-imported before use. UTF-8 decoding is fatal.
- **PRF secrecy:**
  - The vault rebuilds `clientExtensionResults` from a whitelist (`credProps.rk` and `prf.enabled` only) for both register and login. The rest of the response JSON carries no PRF data.
  - The server deletes `prf.results` again before verifying, and never stores or logs extension output.
  - The vault computes the PRF salt itself rather than using the server's copy.
- **WebAuthn verification:**
  - `userVerification: 'required'` and `requireUserVerification: true` at both ceremonies.
  - rpID and origin come from the request URL. Another origin cannot obtain an assertion for this rpID, because the browser enforces the rpID.
  - Counter regression is handled by simplewebauthn, and the `userHandle` must match the credential owner.
- **Challenges:** single-use via `DELETE ... RETURNING`, kind-scoped, 5-minute expiry checked after consumption.
- **First-run race:** closed in SQL (`INSERT ... WHERE NOT EXISTS (SELECT 1 FROM users)`). The credential and session inserts are conditioned on the new user row, and `countUsers` includes removed users.
- **Double claim:** two concurrent claims of one invite are closed by the conditional insert plus `claimed_by IS NULL` in one batch.
- **Session cookie:**
  - 32 random bytes; the DB stores only SHA-256 of it.
  - HttpOnly, SameSite=Lax, Secure off only on localhost, Path=/, 30 days.
  - Server-side expiry is enforced; the removed-user join is in the lookup; a new value is issued on every login.
- **Logout and removal:** logout deletes the session row. Removal deletes all sessions and revokes member and connector tokens in one batch.
- **CSRF boundary:**
  - The exemption is exactly `/api/remote` and `/api/remote/*`.
  - Probed against `//api/...`, `/API/...`, `%6b`, `%2e%2e`, `..%2f`, `remote%2Dspaces` and trailing slashes: no state-changing handler was reachable without the header.
  - No CORS headers are sent anywhere.
- **Setup:** owner/admin only, once. Every follow-on statement is guarded by `OWN_KEY_EXISTS` (id, created_at, public_key, live). A recovery wrap of both keys is required, and PRF wraps must name a credential the caller owns.
- **Rotation:**
  - Owner/admin only; members get 403.
  - `previousKid` must be current, and the new kid must be new.
  - Wraps go only to active members with a key, and none to removed or unknown users or duplicates.
  - It retires all other live keys, and only when the new key row is the caller's.
  - The batch order (insert key, retire others, add wraps, expire invites) is correct: the guards still see the new key as live.
- **Import:**
  - Writes only the caller's own rows, and a `user:` kid must be the caller's.
  - `users.public_key` is write-once, by a JS mismatch check plus `WHERE public_key IS NULL`, so it cannot be set a second time.
  - It cannot attach wraps to other users.
- **Invites:**
  - The creation wrap must be kind `invite` for the current kid. Validity is checked in preview, options and verify.
  - `GET /:id/key` and `/claim` return 404 unless `claimed_by` is the caller.
  - Rotation expires unclaimed invites, so a stale invite cannot hand a new member a retired key, and an invite never carries a newer key.
  - The fragment secret is used only for `unwrapWithSecret` in the browser and is never sent; the invite page clears it with `replaceState`.
- **Tokens:** member and connector tokens are 32 random bytes, stored as SHA-256 hashes and looked up by hash, so timing attacks do not apply. Revoked tokens and removed users are excluded in SQL. Re-claiming revokes the old member token.
- **Vault storage:** keys and PRF output live only in module memory. There is no localStorage, sessionStorage or IndexedDB use anywhere in `web/src`, and `lock()` clears keys, PRF, pending state and the cache.
- **Vault decryption:**
  - Decrypted text is never posted back; the only POST bodies with key material are wraps.
  - An unknown kid or a `user:` kid gives the locked placeholder, and malformed input gives the unreadable placeholder; neither throws.
  - Only http(s) links survive.
  - JSON `__proto__` cannot pollute anything (keys and cache are Maps; spread defines own properties).
  - Envelope ct is capped at 64 KiB per field.
- **`importRemoteKey`:** refuses local kids and `user:` kids, and only adds stored wraps.
- **Logging:** every `logEvent` call passes only ids, roles, counts and booleans. No plaintext, keys, tokens, PRF output or recovery codes are logged anywhere in the reviewed files.
- **`remote-spaces` POST:** owner-only, https-only, bare origin, no userinfo, not its own origin, 4 s timeout, `redirect: 'manual'`, and `member_token` is never returned by GET.
