/** First run: name yourself, create a passkey, save the recovery code. */
import type { SpaceInfo } from '../../src/types.ts';
import { vault } from './vault.ts';
import { $, copyText, errMessage, esc } from './util.ts';
import { NO_WEBAUTHN, brandRow, cardPage, errorBox, showError, webauthnAvailable } from './pages.ts';
import type { Host } from './host.ts';

export function mountOnboarding(root: HTMLElement, space: SpaceInfo, host: Host): () => void {
  const shared = space.kind === 'shared';
  root.innerHTML = cardPage(`
    ${brandRow('First run')}
    <h1 class="card-title">Set up ${esc(space.name)}</h1>
    <p class="lede">${
      shared
        ? 'You are creating the shared space. Titles and notes are encrypted in your browser with a key only passkeys can open. The server never sees them.'
        : 'This is your private copy. Titles and notes are encrypted in your browser with a key only your passkey can open. The server never sees them.'
    }</p>
    <label class="field"><span>What should we call you?</span>
      <input id="handle" type="text" autocomplete="nickname" maxlength="40" placeholder="Chris" spellcheck="false"></label>
    ${errorBox()}
    <div class="actions"><button class="btn primary" id="go">Create passkey</button></div>
    <p class="fine">Next your device asks for Face ID, Touch ID, Windows Hello or a security key. That is your passkey. You will use it every time you open Mission Control.</p>`);
  const card = root.querySelector('.card') as HTMLElement;
  const input = $<HTMLInputElement>('#handle', card);
  input.focus();
  if (!webauthnAvailable()) showError(card, NO_WEBAUTHN);

  const go = $<HTMLButtonElement>('#go', card);
  const run = async () => {
    const handle = input.value.trim();
    if (!handle) {
      showError(card, 'Tell us what to call you first.');
      input.focus();
      return;
    }
    go.disabled = true;
    go.textContent = 'Waiting for your device…';
    showError(card, '');
    try {
      const { recoveryCode } = await vault.setup(handle);
      showRecovery(recoveryCode);
    } catch (e) {
      showError(card, errMessage(e));
      go.disabled = false;
      go.textContent = 'Create passkey';
    }
  };
  go.onclick = () => void run();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') void run();
  };

  function showRecovery(code: string): void {
    card.innerHTML = `
      ${brandRow('Recovery code')}
      <h1 class="card-title">Save your recovery code</h1>
      <p class="lede">If you lose this device or your passkey stops working, this code is the only way back in. We cannot reset it for you. Store it in a password manager or print it.</p>
      <div class="codebox big" id="code" aria-label="Recovery code">${esc(code)}</div>
      <div class="actions"><button class="btn" id="copy">Copy code</button></div>
      <label class="check"><input type="checkbox" id="saved"> <span>I saved it somewhere safe</span></label>
      <div class="actions"><button class="btn primary" id="next" disabled>Continue</button></div>`;
    const saved = $<HTMLInputElement>('#saved', card);
    const next = $<HTMLButtonElement>('#next', card);
    saved.onchange = () => (next.disabled = !saved.checked);
    $('#copy', card).onclick = async (ev) => {
      const ok = await copyText(code);
      (ev.target as HTMLElement).textContent = ok ? 'Copied' : 'Select the code and copy it';
    };
    next.onclick = () => host.navigate('/setup', true);
  }
  return () => undefined;
}
