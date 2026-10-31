/** Entry point. Router by location.pathname, plus the first-run / locked / unlocked lifecycle. */
import { api } from './api.ts';
import { vault } from './vault.ts';
import { store } from './store.ts';
import { $ } from './util.ts';
import { mountOnboarding } from './onboarding.ts';
import { mountUnlock } from './unlock.ts';
import { mountSetup } from './setup.ts';
import { mountInvite } from './invite.ts';
import { mountConnect } from './connect.ts';
import { mountBoard } from './board/page.ts';
import { cardPage, brandRow } from './pages.ts';
import type { Host } from './host.ts';
import type { SpaceInfo } from '../../src/types.ts';

const root = (): HTMLElement => $('#app');
let dispose: (() => void) | null = null;
let routing = 0;

function swap(next: (() => void) | undefined): void {
  dispose?.();
  dispose = next ?? null;
}

function fail(message: string): void {
  swap(undefined);
  root().innerHTML = cardPage(`${brandRow('Mission Control')}<h1 class="card-title">Could not load</h1><p class="lede">${message.replace(/[<>&]/g, '')}</p><div class="actions"><button class="btn primary" id="retry">Try again</button></div>`);
  $('#retry').onclick = () => void route();
}

const host: Host = {
  navigate(path, replace) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    void route();
  },
  onAuthLost() {
    void route();
  },
  route() {
    void route();
  },
};

async function route(): Promise<void> {
  const mine = ++routing;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(location.search);

  // Dev only: render the board from built-in sample data, no server and no vault.
  if (params.get('fixture') === '1' && path === '/') {
    store.fixture = true;
    store.handle = 'Chris';
    swap(await mountBoard(root(), host));
    return;
  }

  let space: SpaceInfo;
  try {
    space = await api.space();
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'The server did not answer.');
  }
  if (mine !== routing) return;
  store.spaceKind = space.kind;

  // The invite page works without a session: the invitee has no passkey yet.
  const inviteMatch = /^\/invite\/([^/]+)$/.exec(path);
  if (inviteMatch && space.setupComplete) {
    swap(await mountInvite(root(), decodeURIComponent(inviteMatch[1] as string), host));
    return;
  }

  if (!space.setupComplete) {
    swap(mountOnboarding(root(), space, host));
    return;
  }
  if (vault.state() === 'locked') {
    swap(mountUnlock(root(), space, host));
    return;
  }

  const me = await api.me().catch(() => null);
  if (mine !== routing) return;
  if (!me) {
    // Vault is unlocked in memory but the session cookie is gone or expired. Re-authenticate.
    vault.lock();
    swap(mountUnlock(root(), space, host));
    return;
  }
  store.handle = me.handle;

  if (path === '/setup') swap(await mountSetup(root(), space, host));
  else if (path === '/connect') swap(mountConnect(root(), host));
  else swap(await mountBoard(root(), host));
}

// In-app links: <a data-nav href="/setup"> navigates without a reload.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a[data-nav]') as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  host.navigate(a.getAttribute('href') ?? '/');
});
addEventListener('popstate', () => void route());

void route();
