/** /connect#payload. Add a shared space to this (personal) copy. */
import { api, ApiError } from './api.ts';
import { vault } from './vault.ts';
import type { ConnectPayload } from './vault-types.ts';
import { $, decodeJsonB64u, errMessage, esc } from './util.ts';
import { brandRow, cardPage, errorBox, showError } from './pages.ts';
import type { Host } from './host.ts';

export function parseConnectLink(raw: string): ConnectPayload {
  const frag = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw;
  const p = decodeJsonB64u<Partial<ConnectPayload>>(frag.trim());
  if (!p || typeof p.name !== 'string' || typeof p.baseUrl !== 'string' || typeof p.memberToken !== 'string') {
    throw new Error('That is not a Mission Control connect link.');
  }
  return p as ConnectPayload;
}

/** Hand the payload to the vault (keys) and to this copy's API (where to fetch from). */
export async function importSharedSpace(p: ConnectPayload): Promise<void> {
  await vault.importRemoteKey(p);
  try {
    await api.addRemoteSpace({ name: p.name, baseUrl: p.baseUrl.replace(/\/+$/, ''), memberToken: p.memberToken });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) throw e;
  }
}

export function mountConnect(root: HTMLElement, host: Host): () => void {
  let payload: ConnectPayload | null = null;
  try {
    payload = parseConnectLink(location.hash);
  } catch {
    payload = null;
  }
  if (!payload) {
    root.innerHTML = cardPage(`${brandRow('Connect')}<h1 class="card-title">This link does not work</h1>
      <p class="lede">The connect link is missing or damaged. Ask for a new one from the shared space, and open it whole, including everything after the #.</p>
      <div class="actions"><a class="btn" href="/" data-nav>Back to Mission Control</a></div>`);
    return () => undefined;
  }
  root.innerHTML = cardPage(`${brandRow('Connect')}
    <h1 class="card-title">Add ${esc(payload.name)}</h1>
    <p class="lede">This adds the shared space <b>${esc(payload.name)}</b> (${esc(payload.baseUrl)}) to your Mission Control. Its projects will show up in your agents' project list, and its work appears on your board marked as shared.</p>
    ${errorBox()}
    <div class="actions"><button class="btn primary" id="add">Add shared space</button><a class="btn" href="/" data-nav>Cancel</a></div>`);
  const card = root.querySelector('.card') as HTMLElement;
  const add = $<HTMLButtonElement>('#add', card);
  add.onclick = async () => {
    add.disabled = true;
    showError(card, '');
    try {
      await importSharedSpace(payload as ConnectPayload);
      history.replaceState(null, '', '/connect');
      host.navigate('/setup', true);
    } catch (e) {
      showError(card, errMessage(e));
      add.disabled = false;
    }
  };
  return () => undefined;
}
