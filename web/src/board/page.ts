/** The board page: shell markup, data loading, polling, and wiring of every renderer. */
import type { Range, Tool } from '../../../src/types.ts';
import { api, ApiError } from '../api.ts';
import { vault } from '../vault.ts';
import { $, $$, esc, errMessage } from '../util.ts';
import { store, hooks } from '../store.ts';
import { buildModel, computePulse } from '../model.ts';
import type { Model } from '../model.ts';
import { renderGreeting, renderHud, renderLegends } from './hud.ts';
import { renderReactor } from './reactor.ts';
import { renderNeeds, wireNeedsAll } from './needs.ts';
import { renderActivity } from './activity.ts';
import { renderProjects } from './projects.ts';
import { renderDecay, wireStaleAll } from './decay.ts';
import { refreshSheet, closeSheet } from './sheet.ts';
import { toast } from './toast.ts';

export interface BoardHost {
  navigate(path: string): void;
  /** Session or vault lost: show the unlock screen. */
  onAuthLost(): void;
}

const SHELL = `
<div class="backdrop"><div class="haze"></div><div class="grid"></div><div class="scan"></div></div>
<div class="app">
  <div class="toolbar">
    <div class="brand"><span class="dot"></span><span id="brandName">Mission Control</span></div>
    <div class="spacer"></div>
    <div class="seg" id="range" role="tablist" aria-label="Time range">
      <button role="tab" data-r="24h" aria-selected="false">24H</button><button role="tab" data-r="7d" aria-selected="true" class="on">7D</button><button role="tab" data-r="30d" aria-selected="false">30D</button>
    </div>
    <button class="iconbtn" id="syncBtn" title="Sync now"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg><span id="syncTxt">Syncing…</span></button>
    <a class="iconbtn" href="/setup" data-nav title="Connector, projects and sharing"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/></svg>Setup</a>
    <button class="iconbtn" id="lockBtn" title="Lock Mission Control"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.6" rx="1.8"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/></svg>Lock</button>
  </div>

  <h1 class="largetitle">Mission Control</h1>
  <div class="subtitle" id="greeting"></div>
  <div id="banner"></div>

  <div class="hud" id="hud" role="group" aria-label="Status summary"></div>

  <div class="grid2">
    <section class="panel">
      <div class="phead"><h2>Where work is running</h2><span class="hint">RINGS = TOOLS · SECTORS = PROJECTS</span></div>
      <div class="legend" id="legendA" style="margin-bottom:6px"></div>
      <div class="reactor"><svg id="reactor" viewBox="-112 -36 744 592" role="group" aria-label="Radial map of workstreams by tool and project"></svg></div>
    </section>
    <div style="display:flex;flex-direction:column;gap:18px;min-width:0">
      <section class="panel">
        <div class="phead"><h2>Needs you</h2><span class="hint" id="needsHint"></span><button class="link" id="needsAll">See all</button></div>
        <div class="list" id="needsList"></div>
      </section>
      <section class="panel chart">
        <div class="phead"><h2>Agent activity</h2><span class="hint" id="actHint"></span></div>
        <div class="legend" id="legendB" style="margin-bottom:8px"></div>
        <svg id="activity" viewBox="0 0 640 230" role="group" aria-label="Line chart of agent actions over time by tool"></svg>
      </section>
    </div>
  </div>

  <div class="grid2">
    <section class="panel">
      <div class="phead"><h2>Projects</h2><span class="hint">ACTIVITY PULSE · 14 DAYS</span></div>
      <div class="list" id="projList"></div>
    </section>
    <section class="panel chart">
      <div class="phead"><h2>Going cold</h2><span class="hint">DAYS SINCE ANYONE TOUCHED IT</span><button class="link" id="staleAll">Review stale</button></div>
      <svg id="decay" viewBox="0 0 620 320" role="group" aria-label="Strip plot of open workstreams by days since last activity"></svg>
    </section>
  </div>
  <div class="footer">Every number, ring, line and dot opens what is behind it.<span id="ver"></span></div>
</div>`;

declare const __APP_VERSION__: string;

let pulseCache: { at: number; pulse: Model['pulse'] } | null = null;

async function fetchModel(): Promise<Model> {
  if (store.fixture) {
    const { fixtureBoard } = await import('../fixture.ts');
    return buildModel(fixtureBoard(store.range));
  }
  if (vault.state() !== 'unlocked') throw new ApiError(401, 'locked', 'Mission Control is locked.');
  const range = store.range;
  const needPulse = range !== '30d' && (!pulseCache || Date.now() - pulseCache.at > 120_000);
  // Sparklines need 30 days of updates whatever the chart range is. Counting needs no plaintext, so skip decrypting that copy.
  const [raw, raw30] = await Promise.all([api.board(range), needPulse ? api.board('30d').catch(() => null) : Promise.resolve(null)]);
  const decrypted = await vault.decryptBoard(raw);
  if (range === '30d') pulseCache = { at: Date.now(), pulse: computePulse(raw) };
  else if (raw30) pulseCache = { at: Date.now(), pulse: computePulse(raw30) };
  return buildModel(decrypted, pulseCache?.pulse);
}

function banner(m: Model): void {
  const parts: string[] = [];
  for (const e of m.remoteErrors) parts.push(`<div class="note warn">${esc(e)} Showing what this copy already has.</div>`);
  if (!m.items.length && !m.remoteErrors.length) {
    parts.push(
      `<div class="callout"><b>Nothing here yet.</b> Open <a href="/setup" data-nav>Setup</a>, add your projects, and copy the connector link into Claude, Claude Code or ChatGPT. The first report shows up here within seconds.</div>`,
    );
  }
  $('#banner').innerHTML = parts.join('');
}

export async function mountBoard(root: HTMLElement, host: BoardHost): Promise<() => void> {
  root.innerHTML = SHELL;
  $('#ver').textContent = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== 'dev' ? ` · ${__APP_VERSION__}` : '';
  $$<HTMLElement>('#range button').forEach((b) => b.classList.toggle('on', b.dataset.r === store.range));
  $$<HTMLElement>('#range button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.r === store.range)));

  const renderAll = () => {
    if (!store.model) return;
    $('#brandName').textContent = `Mission Control · ${store.model.spaceName}${store.fixture ? ' · fixture' : ''}`;
    renderGreeting();
    renderHud();
    renderLegends();
    renderReactor();
    renderNeeds();
    renderActivity();
    renderProjects();
    renderDecay();
    banner(store.model);
    refreshSheet();
  };

  let inflight: Promise<void> | null = null;
  let queued = false;
  let alive = true;
  const syncText = () => {
    const el = document.getElementById('syncTxt');
    if (!el || !store.lastSyncAt) return;
    const s = Math.round((Date.now() - store.lastSyncAt) / 1000);
    el.textContent = s < 45 ? 'Synced just now' : s < 3600 ? `Synced ${Math.round(s / 60)} min ago` : `Synced ${Math.round(s / 3600)}h ago`;
  };
  const refresh = (): Promise<void> => {
    if (inflight) {
      queued = true;
      return inflight;
    }
    $('#syncTxt').textContent = 'Syncing…';
    inflight = (async () => {
      try {
        const m = await fetchModel();
        if (!alive) return;
        store.model = m;
        store.lastSyncAt = Date.now();
        renderAll();
        syncText();
      } catch (e) {
        if (!alive) return;
        if ((e instanceof ApiError && e.status === 401) || vault.state() === 'locked') {
          host.onAuthLost();
          return;
        }
        $('#syncTxt').textContent = 'Sync failed';
        toast(errMessage(e));
      } finally {
        inflight = null;
        if (queued && alive) {
          queued = false;
          void refresh();
        }
      }
    })();
    return inflight;
  };
  hooks.refresh = refresh;
  hooks.setTool = (t: Tool | null) => {
    store.tool = t && store.tool !== t ? t : null;
    renderAll();
  };

  $$<HTMLElement>('#range button').forEach((b) => {
    b.onclick = () => {
      store.range = b.dataset.r as Range;
      $$<HTMLElement>('#range button').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-selected', String(x === b));
      });
      void refresh();
    };
  });
  $('#syncBtn').onclick = () => {
    void refresh().then(() => toast('Pulled the latest from every tool'));
  };
  $('#lockBtn').onclick = () => {
    vault.lock();
    store.model = null;
    closeSheet();
    host.onAuthLost();
  };
  wireNeedsAll();
  wireStaleAll();

  await refresh();

  const poll = setInterval(() => {
    if (document.visibilityState === 'visible' && !store.fixture) void refresh();
  }, 30_000);
  const tick = setInterval(syncText, 15_000);
  const onVis = () => {
    if (document.visibilityState === 'visible' && !store.fixture && Date.now() - store.lastSyncAt > 10_000) void refresh();
  };
  document.addEventListener('visibilitychange', onVis);

  return () => {
    alive = false;
    clearInterval(poll);
    clearInterval(tick);
    document.removeEventListener('visibilitychange', onVis);
    closeSheet();
  };
}
