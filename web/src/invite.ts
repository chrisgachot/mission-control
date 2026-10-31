/** /invite/:id#secret. Claim a seat in a shared space, then hand the member to their personal copy. */
import { api } from './api.ts';
import { vault } from './vault.ts';
import type { ConnectPayload } from './vault-types.ts';
import { $, copyText, encodeJsonB64u, errMessage, esc } from './util.ts';
import { NO_WEBAUTHN, brandRow, cardPage, errorBox, showError, webauthnAvailable } from './pages.ts';
import type { Host } from './host.ts';

export async function mountInvite(root: HTMLElement, id: string, host: Host): Promise<() => void> {
  const secret = location.hash.replace(/^#/, '');
  root.innerHTML = cardPage(`${brandRow('Invitation')}<p class="lede">Checking your invitation…</p>`);
  const card = root.querySelector('.card') as HTMLElement;

  let preview;
  try {
    preview = await api.invitePreview(id);
  } catch (e) {
    preview = { valid: false } as const;
    void e;
  }
  if (!preview.valid || !secret) {
    card.innerHTML = `${brandRow('Invitation')}<h1 class="card-title">This invitation does not work</h1>
      <p class="lede">${secret ? 'It has expired or was already used.' : 'The link is missing its secret part (everything after the #). Ask for a fresh link and open it whole.'} Invitations last 7 days and work once.</p>
      <div class="actions"><a class="btn" href="/" data-nav>Go to Mission Control</a></div>`;
    return () => undefined;
  }

  card.innerHTML = `${brandRow('Invitation')}
    <h1 class="card-title">Join ${esc(preview.spaceName ?? 'a shared space')}</h1>
    <p class="lede">You were invited as ${esc(preview.role ?? 'member')}. Shared titles and notes are encrypted; your invite link carries the key, and only your passkey keeps it afterwards.</p>
    <label class="field"><span>What should we call you?</span><input id="handle" type="text" maxlength="40" autocomplete="nickname" spellcheck="false"></label>
    ${errorBox()}
    <div class="actions"><button class="btn primary" id="join">Create passkey and join</button></div>`;
  if (!webauthnAvailable()) showError(card, NO_WEBAUTHN);
  const handle = $<HTMLInputElement>('#handle', card);
  handle.focus();
  const join = $<HTMLButtonElement>('#join', card);
  const run = async () => {
    const h = handle.value.trim();
    if (!h) return showError(card, 'Tell us what to call you first.');
    join.disabled = true;
    join.textContent = 'Waiting for your device…';
    showError(card, '');
    try {
      const payload = await vault.claimInvite(id, secret, h);
      history.replaceState(null, '', location.pathname);
      showConnect(payload);
    } catch (e) {
      showError(card, errMessage(e));
      join.disabled = false;
      join.textContent = 'Create passkey and join';
    }
  };
  join.onclick = () => void run();
  handle.onkeydown = (e) => {
    if (e.key === 'Enter') void run();
  };

  function showConnect(payload: ConnectPayload & { recoveryCode?: string }): void {
    const { recoveryCode, ...clean } = payload;
    card.innerHTML = `${brandRow('Joined')}
      <h1 class="card-title">You are in</h1>
      ${recoveryCode ? `<p class="lede">Save this recovery code first. It is the only way back in if you lose your passkey.</p><div class="codebox big">${esc(recoveryCode)}</div>` : ''}
      <p class="lede">Next, connect your own Mission Control so your agents can report into ${esc(payload.name)}. Paste the address of your personal copy and open the link we build for you. Nothing in that link is sent to any server.</p>
      <label class="field"><span>Your Mission Control address</span><input id="home" type="url" placeholder="https://mission-control.yourname.workers.dev" spellcheck="false"></label>
      <div class="codebox" id="link" hidden></div>
      <div class="actions"><button class="btn primary" id="build">Build my connect link</button><a class="btn" id="open" hidden target="_self">Open it</a><button class="btn" id="copy" hidden>Copy</button></div>
      <p class="fine"><button class="textbtn" id="skip">Skip for now</button></p>`;
    const home = $<HTMLInputElement>('#home', card);
    $('#build', card).onclick = () => {
      let origin: string;
      try {
        const u = new URL(home.value.trim());
        if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('https only');
        origin = u.origin;
      } catch {
        return showError(card, 'That does not look like an https address.');
      }
      const url = `${origin}/connect#${encodeJsonB64u(clean)}`;
      const link = $('#link', card);
      link.hidden = false;
      link.textContent = url;
      const open = $<HTMLAnchorElement>('#open', card);
      open.href = url;
      open.hidden = false;
      const copy = $<HTMLButtonElement>('#copy', card);
      copy.hidden = false;
      copy.onclick = async () => (copy.textContent = (await copyText(url)) ? 'Copied' : 'Copy failed');
    };
    $('#skip', card).onclick = () => host.navigate('/', true);
    card.insertAdjacentHTML('beforeend', errorBox());
  }
  return () => undefined;
}
