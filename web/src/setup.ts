/** /setup: connector link, agent instructions, projects, shared spaces, members and invites. */
import type { ProjectRow, SetupResponse, SpaceInfo } from '../../src/types.ts';
import { api } from './api.ts';
import type { Me, Member, RemoteSpaceInfo } from './api.ts';
import { vault } from './vault.ts';
import { $, $$, copyText, errMessage, esc } from './util.ts';
import { BACKDROP } from './pages.ts';
import { toast } from './board/toast.ts';
import { importSharedSpace, parseConnectLink } from './connect.ts';
import type { Host } from './host.ts';


/** Inline `code` spans in instruction strings; everything else is escaped. */
function rich(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

export async function mountSetup(root: HTMLElement, space: SpaceInfo, host: Host): Promise<() => void> {
  const shared = space.kind === 'shared';
  root.innerHTML = `${BACKDROP}
  <div class="app narrow">
    <div class="toolbar">
      <a class="iconbtn" href="/" data-nav>‹ Board</a>
      <div class="brand"><span class="dot"></span>Setup · ${esc(space.name)}</div>
      <div class="spacer"></div>
      <button class="iconbtn" id="lockBtn">Lock</button>
    </div>
    <h1 class="largetitle">Setup</h1>
    <div class="subtitle" id="who"></div>
    <section class="panel" id="secConnector"><div class="phead"><h2>Connector link</h2><span class="hint">ONE PER PERSON</span></div><div id="connector"><p class="muted">Loading…</p></div></section>
    <section class="panel" id="secInstr"><div class="phead"><h2>Connect an agent</h2></div><div id="instr"><p class="muted">Loading…</p></div></section>
    <section class="panel" id="secProjects"><div class="phead"><h2>Projects</h2><span class="hint">AGENTS CAN ONLY PICK FROM THIS LIST</span></div><div id="projects"><p class="muted">Loading…</p></div></section>
    ${shared ? '' : `<section class="panel" id="secRemote"><div class="phead"><h2>Shared spaces</h2><span class="hint">FROM YOUR TEAM</span></div><div id="remote"><p class="muted">Loading…</p></div></section>`}
    ${shared ? `<section class="panel" id="secMembers"><div class="phead"><h2>Members and invites</h2></div><div id="members"><p class="muted">Loading…</p></div></section>` : ''}
    <div class="footer">Mission Control ${typeof __APP_VERSION__ === 'string' ? esc(__APP_VERSION__) : ''}</div>
  </div>`;
  let alive = true;
  $('#lockBtn').onclick = () => {
    vault.lock();
    host.onAuthLost();
  };

  const me: Me | null = await api.me().catch(() => null);
  if (!me) {
    host.onAuthLost();
    return () => undefined;
  }
  $('#who').textContent = `Signed in as ${me.handle}${me.role ? ' · ' + me.role : ''}.`;
  const canEdit = me.role === 'owner' || me.role === 'admin';

  // ---------- connector ----------
  let setupData: SetupResponse | null = null;
  const renderConnector = () => {
    const el = $('#connector');
    if (!setupData) return;
    const masked = setupData.tokenMasked;
    el.innerHTML = `
      <p class="muted">Paste this link into Claude, Claude Code, Cowork, Duet or ChatGPT as a custom connector. Anyone with the link can report work into your Mission Control, so treat it like a password.</p>
      <div class="linkbox"><input id="cUrl" readonly value="${esc(setupData.connectorUrl)}" aria-label="Connector link" ${masked ? 'class="masked"' : ''}>
        <button class="btn primary" id="cCopy" ${masked ? 'disabled' : ''}>Copy</button></div>
      ${
        masked
          ? `<p class="note">For your safety the full link is shown only once, right after it is created or rotated. If you did not copy it, rotate it to get a new one.</p>`
          : `<p class="note good">Copy this now. Once you leave this page it is hidden, and the only way to see a link again is to rotate it.</p>`
      }
      <div class="actions"><button class="btn" id="cRotate">Rotate link</button></div>
      <p class="fine">Rotating makes a new link and <b>immediately stops the old one</b>. Every agent using the old link will need the new one.</p>`;
    $('#cCopy').onclick = async (e) => {
      const ok = await copyText(setupData?.connectorUrl ?? '');
      (e.target as HTMLElement).textContent = ok ? 'Copied' : 'Copy failed';
      toast(ok ? 'Connector link copied' : 'Could not copy. Select the link and copy it.');
    };
    $('#cRotate').onclick = async (e) => {
      if (!confirm('Rotate the connector link? The current link stops working immediately.')) return;
      const b = e.target as HTMLButtonElement;
      b.disabled = true;
      try {
        setupData = await api.rotateToken();
        renderConnector();
        renderInstr();
        toast('New link created. The old one no longer works.');
      } catch (err) {
        toast(errMessage(err));
        b.disabled = false;
      }
    };
  };

  // ---------- instructions ----------
  type TabKey = 'claude' | 'claudeCode' | 'chatgpt' | 'reportingRules';
  let tab: TabKey = 'claude';
  const TABS: Array<[TabKey, string]> = [
    ['claude', 'Claude, Cowork, Duet'],
    ['claudeCode', 'Claude Code'],
    ['chatgpt', 'ChatGPT'],
    ['reportingRules', 'Reporting rules'],
  ];
  const renderInstr = () => {
    const el = $('#instr');
    if (!setupData) return;
    const ins = setupData.instructions;
    let content: string;
    if (tab === 'reportingRules') {
      content = `<p class="muted">Paste this into the instructions or project rules of any agent so it reports only what matters.</p><div class="codebox wrap" id="rules">${esc(ins.reportingRules)}</div><div class="actions"><button class="btn" id="rulesCopy">Copy rules</button></div>`;
    } else {
      const steps = ins[tab];
      content = `<ol class="steps">${steps.map((s, i) => `<li>${rich(s)}${/^claude mcp add/.test(s.trim()) ? ` <button class="textbtn" data-copy="${i}">Copy</button>` : ''}</li>`).join('')}</ol>`;
    }
    el.innerHTML = `<div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" class="tab ${k === tab ? 'on' : ''}" aria-selected="${k === tab}" data-tab="${k}">${esc(l)}</button>`).join('')}</div>${content}`;
    $$<HTMLElement>('[data-tab]', el).forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.tab as TabKey;
        renderInstr();
      };
    });
    const rc = el.querySelector<HTMLElement>('#rulesCopy');
    if (rc) rc.onclick = async () => toast((await copyText(ins.reportingRules)) ? 'Rules copied' : 'Could not copy');
    $$<HTMLElement>('[data-copy]', el).forEach((b) => {
      b.onclick = async () => {
        const step = ins[tab as 'claude' | 'claudeCode' | 'chatgpt'][Number(b.dataset.copy)] ?? '';
        const cmd = step.replace(/`/g, '');
        toast((await copyText(cmd)) ? 'Command copied' : 'Could not copy');
      };
    });
  };

  // ---------- projects ----------
  let projects: ProjectRow[] = [];
  let renaming: string | null = null;
  const renderProjects = () => {
    const el = $('#projects');
    const active = projects.filter((p) => p.archivedAt === null);
    const archived = projects.filter((p) => p.archivedAt !== null);
    el.innerHTML = `
      <p class="muted">Agents can only file work under projects on this list. They cannot create new ones, so names stay tidy.${canEdit ? '' : ' Only the owner or an admin can change this list.'}</p>
      ${
        active.length
          ? `<div class="list">${active
              .map((p) =>
                renaming === p.id
                  ? `<div class="row static"><input class="inline" id="rn" value="${esc(p.name)}" maxlength="60" aria-label="Project name"><button class="pill" data-save="${esc(p.id)}">Save</button><button class="pill plain" data-cancel>Cancel</button></div>`
                  : `<div class="row static"><div class="rtext"><div class="rtitle">${esc(p.name)}</div>${p.remoteSpaceId ? '<div class="rsub"><span class="shared">shared project</span></div>' : ''}</div>${
                      canEdit
                        ? `${p.remoteSpaceId ? '' : `<button class="pill plain" data-rename="${esc(p.id)}">Rename</button>`}<button class="pill plain danger" data-archive="${esc(p.id)}">Archive</button>`
                        : ''
                    }</div>`,
              )
              .join('')}</div>`
          : `<div class="empty">No projects yet. Add one below, for example the name of a client, a product or "Personal".</div>`
      }
      ${
        canEdit
          ? `<form class="inline-form" id="addProject"><input id="newProject" maxlength="60" placeholder="New project name" aria-label="New project name" autocomplete="off"><button class="btn primary" type="submit">Add project</button></form>`
          : ''
      }
      ${
        archived.length
          ? `<details class="arch"><summary>${archived.length} archived</summary><div class="list">${archived
              .map((p) => `<div class="row static"><div class="rtext"><div class="rtitle dim">${esc(p.name)}</div></div>${canEdit ? `<button class="pill plain" data-restore="${esc(p.id)}">Restore</button>` : ''}</div>`)
              .join('')}</div></details>`
          : ''
      }`;
    const reload = async () => {
      projects = await api.projects();
      renaming = null;
      renderProjects();
    };
    const guard = async (fn: () => Promise<unknown>, ok: string) => {
      try {
        await fn();
        await reload();
        toast(ok);
      } catch (e) {
        toast(errMessage(e));
      }
    };
    $$<HTMLElement>('[data-rename]', el).forEach((b) => (b.onclick = () => ((renaming = b.dataset.rename as string), renderProjects(), el.querySelector<HTMLInputElement>('#rn')?.select())));
    $$<HTMLElement>('[data-cancel]', el).forEach((b) => (b.onclick = () => ((renaming = null), renderProjects())));
    $$<HTMLElement>('[data-save]', el).forEach((b) => {
      const save = () => guard(() => api.renameProject(b.dataset.save as string, $<HTMLInputElement>('#rn', el).value.trim()), 'Renamed');
      b.onclick = () => void save();
      el.querySelector<HTMLInputElement>('#rn')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void save();
        if (e.key === 'Escape') ((renaming = null), renderProjects());
      });
    });
    $$<HTMLElement>('[data-archive]', el).forEach((b) => {
      b.onclick = () => {
        const p = projects.find((x) => x.id === b.dataset.archive);
        if (p && confirm(`Archive "${p.name}"? Its work disappears from the board; you can restore it later.`)) void guard(() => api.archiveProject(p.id, true), 'Archived');
      };
    });
    $$<HTMLElement>('[data-restore]', el).forEach((b) => (b.onclick = () => void guard(() => api.archiveProject(b.dataset.restore as string, false), 'Restored')));
    const form = el.querySelector<HTMLFormElement>('#addProject');
    if (form)
      form.onsubmit = (e) => {
        e.preventDefault();
        const name = $<HTMLInputElement>('#newProject', el).value.trim();
        if (!name) return;
        void guard(() => api.createProject(name), 'Project added');
      };
  };

  // ---------- shared spaces (personal copy) ----------
  let remotes: RemoteSpaceInfo[] = [];
  const renderRemote = () => {
    const el = document.getElementById('remote');
    if (!el) return;
    el.innerHTML = `
      <p class="muted">Shared spaces let a team see work on shared projects. Ask the space admin for an invite; after you join they give you a connect link. Paste it here.</p>
      ${
        remotes.length
          ? `<div class="list">${remotes
              .map(
                (r) =>
                  `<div class="row static"><div class="rtext"><div class="rtitle">${esc(r.name)}</div><div class="rsub"><span class="m">${esc(r.baseUrl)}</span>${r.lastError ? `<span class="badge stale">${esc(r.lastError)}</span>` : ''}</div></div><button class="pill plain danger" data-rm="${esc(r.id)}">Remove</button></div>`,
              )
              .join('')}</div>`
          : `<div class="empty">No shared spaces connected.</div>`
      }
      <form class="inline-form" id="addRemote"><input id="rLink" placeholder="Paste a connect link" aria-label="Connect link" autocomplete="off" spellcheck="false"><button class="btn primary" type="submit">Add</button></form>`;
    $$<HTMLElement>('[data-rm]', el).forEach((b) => {
      b.onclick = async () => {
        const r = remotes.find((x) => x.id === b.dataset.rm);
        if (!r || !confirm(`Remove ${r.name}? Your agents will stop reporting into it. Work already there stays there.`)) return;
        try {
          await api.removeRemoteSpace(r.id);
          remotes = await api.remoteSpaces();
          renderRemote();
          toast('Removed');
        } catch (e) {
          toast(errMessage(e));
        }
      };
    });
    $<HTMLFormElement>('#addRemote', el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await importSharedSpace(parseConnectLink($<HTMLInputElement>('#rLink', el).value));
        remotes = await api.remoteSpaces();
        renderRemote();
        toast('Shared space added');
      } catch (err) {
        toast(errMessage(err));
      }
    };
  };

  // ---------- members (shared copy) ----------
  let members: Member[] = [];
  let inviteUrl = '';
  const renderMembers = () => {
    const el = document.getElementById('members');
    if (!el) return;
    el.innerHTML = `
      <p class="muted">${canEdit ? 'Invite people with a one-time link. It carries the key to this space inside its #fragment, so the server never sees it. Links last 7 days.' : 'Only an admin can invite or remove people.'}</p>
      ${
        canEdit
          ? `<div class="inline-form"><select id="invRole" aria-label="Role"><option value="member">Member</option><option value="admin">Admin</option></select><button class="btn primary" id="invMake">Create invite link</button></div>
      ${inviteUrl ? `<div class="linkbox"><input id="invUrl" readonly value="${esc(inviteUrl)}" aria-label="Invite link"><button class="btn" id="invCopy">Copy</button></div><p class="fine">Send this to one person only. It works once.</p>` : ''}`
          : ''
      }
      <div class="sect">People</div>
      <div class="list">${members
        .map(
          (m) =>
            `<div class="row static"><div class="rtext"><div class="rtitle">${esc(m.handle)}${m.id === me?.id ? ' <span class="m">(you)</span>' : ''}</div><div class="rsub"><span>${esc(m.role)}</span></div></div>${canEdit && m.id !== me?.id && m.role !== 'owner' ? `<button class="pill plain danger" data-rm="${esc(m.id)}">Remove</button>` : ''}</div>`,
        )
        .join('') || '<div class="empty">Just you so far.</div>'}</div>`;
    const make = el.querySelector<HTMLButtonElement>('#invMake');
    if (make)
      make.onclick = async () => {
        make.disabled = true;
        try {
          inviteUrl = await vault.createInvite(((el.querySelector('#invRole') as unknown as { value: string } | null)?.value ?? 'member') as 'member' | 'admin');
          renderMembers();
        } catch (e) {
          toast(errMessage(e));
          make.disabled = false;
        }
      };
    const copy = el.querySelector<HTMLButtonElement>('#invCopy');
    if (copy) copy.onclick = async () => toast((await copyText(inviteUrl)) ? 'Invite link copied' : 'Could not copy');
    $$<HTMLButtonElement>('[data-rm]', el).forEach((b) => {
      b.onclick = async () => {
        const m = members.find((x) => x.id === b.dataset.rm);
        if (!m || !confirm(`Remove ${m.handle}? They lose access immediately and the space key is rotated for everyone else.`)) return;
        b.disabled = true;
        b.textContent = 'Removing…';
        try {
          await api.removeMember(m.id);
          await vault.rotateAfterRemoval();
          members = await api.members();
          renderMembers();
          toast(`${m.handle} removed and the key rotated`);
        } catch (e) {
          toast(errMessage(e));
          members = await api.members().catch(() => members);
          renderMembers();
        }
      };
    });
  };

  // ---------- load everything, each section on its own ----------
  const section = async <T,>(id: string, load: () => Promise<T>, apply: (v: T) => void) => {
    try {
      apply(await load());
    } catch (e) {
      const el = document.getElementById(id);
      if (el && alive) el.innerHTML = `<div class="err">${esc(errMessage(e))}</div>`;
    }
  };
  await Promise.all([
    section('connector', () => api.setup(), (v) => ((setupData = v), renderConnector(), renderInstr())),
    section('projects', () => api.projects(), (v) => ((projects = v), renderProjects())),
    shared
      ? section('members', () => api.members(), (v) => ((members = v), renderMembers()))
      : section('remote', () => api.remoteSpaces(), (v) => ((remotes = v), renderRemote())),
  ]);
  const instrEl = document.getElementById('instr');
  if (instrEl && !setupData) instrEl.innerHTML = '';
  return () => {
    alive = false;
  };
}

declare const __APP_VERSION__: string;
