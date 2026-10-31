import type { SpaceInfo } from '../../src/types.ts';
import { vault } from './vault.ts';
import { $, errMessage, esc } from './util.ts';
import { NO_WEBAUTHN, brandRow, cardPage, errorBox, showError, webauthnAvailable } from './pages.ts';
import { isNeedsRecoveryCode } from './host.ts';
import type { Host } from './host.ts';

export function mountUnlock(root: HTMLElement, space: SpaceInfo, host: Host): () => void {
  root.innerHTML = cardPage(`
    ${brandRow('Locked')}
    <h1 class="card-title">${esc(space.name)}</h1>
    <p class="lede">Your titles and notes are encrypted. Unlock with your passkey to read them.</p>
    ${errorBox()}
    <div class="actions"><button class="btn primary wide" id="unlock">Unlock with passkey</button></div>
    <div id="rec" hidden>
      <label class="field"><span>Recovery code</span>
        <input id="code" type="text" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"></label>
      <div class="actions"><button class="btn wide" id="useCode">Unlock with recovery code</button></div>
    </div>
    <p class="fine"><button class="textbtn" id="showRec">Use a recovery code instead</button></p>`);
  const card = root.querySelector('.card') as HTMLElement;
  const btn = $<HTMLButtonElement>('#unlock', card);
  const rec = $('#rec', card);
  const showRec = () => {
    rec.hidden = false;
    $<HTMLInputElement>('#code', card).focus();
  };
  if (!webauthnAvailable()) showError(card, NO_WEBAUTHN);

  const done = () => host.route();
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Waiting for your device…';
    showError(card, '');
    try {
      await vault.unlock();
      done();
    } catch (e) {
      if (isNeedsRecoveryCode(e)) {
        showError(card, 'This device cannot unlock with the passkey alone. Enter your recovery code.');
        showRec();
      } else showError(card, errMessage(e));
      btn.disabled = false;
      btn.textContent = 'Unlock with passkey';
    }
  };
  $('#showRec', card).onclick = showRec;
  const useCode = $<HTMLButtonElement>('#useCode', card);
  const submitCode = async () => {
    const code = $<HTMLInputElement>('#code', card).value.trim();
    if (!code) return showError(card, 'Paste your recovery code first.');
    useCode.disabled = true;
    showError(card, '');
    try {
      await vault.unlockWithRecoveryCode(code);
      done();
    } catch (e) {
      showError(card, errMessage(e));
      useCode.disabled = false;
    }
  };
  useCode.onclick = () => void submitCode();
  $<HTMLInputElement>('#code', card).onkeydown = (e) => {
    if (e.key === 'Enter') void submitCode();
  };
  btn.focus();
  return () => undefined;
}
