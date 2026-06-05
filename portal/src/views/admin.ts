import { layout, esc, bytesHuman } from '../lib/html.js';
import type { WorkspaceInfo, DirEntry } from '../lib/dockerctl.js';
import type { WorkspaceTier } from '../lib/users.js';
import { posix as posixPath } from 'node:path';

type AdminSubTab = 'workspaces' | 'users' | 'ports' | 'logs';

function adminSubnav(active: AdminSubTab): string {
  const tab = (label: string, href: string, key: AdminSubTab) =>
    `<a class="${active === key ? 'subtab subtab-active' : 'subtab'}" href="${href}">${label}</a>`;
  return `<nav class="subtabs">
    ${tab('Workspaces', '/admin', 'workspaces')}
    ${tab('Users', '/admin/users', 'users')}
    ${tab('Ports', '/admin/ports', 'ports')}
    ${tab('Logs', '/admin/logs', 'logs')}
  </nav>`;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------
export function renderAdmin(args: {
  user: string;
  workspaces: Array<WorkspaceInfo & { stats?: { cpuPct: number; memBytes: number; memLimit: number } | null }>;
}): string {
  const { user, workspaces } = args;
  const rows = workspaces
    .map((w) => {
      const cpu = w.stats ? `${w.stats.cpuPct.toFixed(1)}%` : '—';
      const mem = w.stats ? `${bytesHuman(w.stats.memBytes)} / ${bytesHuman(w.stats.memLimit)}` : '—';
      const tierCell = w.containerTier
        ? `<span class="badge st-${w.status}">${w.containerTier}</span>`
        : '<span class="muted small">—</span>';
      return `<tr>
        <td><code>${esc(w.user)}</code></td>
        <td><span class="badge st-${w.status}">${w.status}</span></td>
        <td>${tierCell}</td>
        <td>${esc(w.image ?? '—')}</td>
        <td>${esc(w.createdAt ?? '—')}</td>
        <td>${cpu}</td>
        <td>${mem}</td>
        <td class="actions">
          <a class="btn-ghost" href="/admin/logs/${esc(w.user)}" target="_blank" rel="noopener" title="docker logs ws-${esc(w.user)}">Logs</a>
          <a class="btn-ghost" href="/admin/term/${esc(w.user)}/" target="_blank" rel="noopener"
             title="Open ttyd inside ws-${esc(w.user)}. Shares the user's PTY — they'll see your input if they're also connected.">Terminal</a>
          <a class="btn-ghost" href="/admin/files/${esc(w.user)}" target="_blank" rel="noopener"
             title="Browse files under /home/node via docker exec (read-only download).">Files</a>
          ${w.containerTier === 'desktop'
            ? `<a class="btn-ghost" href="/admin/term/${esc(w.user)}/desktop/" target="_blank" rel="noopener"
                 title="Open KasmVNC for ws-${esc(w.user)}. Shares the user's X session.">Desktop</a>`
            : ''}
          <form method="post" action="/admin/workspace/${esc(w.user)}/stop"  style="display:inline"><button>Stop</button></form>
          <form method="post" action="/admin/workspace/${esc(w.user)}/start" style="display:inline"><button>Start</button></form>
          <form method="post" action="/admin/workspace/${esc(w.user)}/destroy" style="display:inline"
                onsubmit="return confirm('Destroy the container for ${esc(w.user)}? The home volume is preserved unless you check the wipe box.');">
            <label style="font-size:11px;color:#8a929e;display:inline-flex;align-items:center;gap:3px;margin-right:4px">
              <input type="checkbox" name="wipe_volume"> wipe data
            </label>
            <button>Destroy</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  const empty = workspaces.length === 0
    ? `<tr><td colspan="8" class="muted">No workspaces yet. They appear after a user signs in and clicks Create.</td></tr>`
    : '';

  const body = `
<section class="container">
  <div class="admin-head">
    <div>
      <h2>Admin</h2>
      <p class="lead">All workspaces on this host.</p>
    </div>
    <a class="btn-ghost" href="/admin">Refresh</a>
  </div>
  ${adminSubnav('workspaces')}
  <table class="admin">
    <thead>
      <tr><th>User</th><th>Status</th><th>Tier</th><th>Image</th><th>Created</th><th>CPU</th><th>Mem</th><th>Actions</th></tr>
    </thead>
    <tbody>${rows}${empty}</tbody>
  </table>
</section>`;
  return layout('Admin — Workspaces', body, { user, isAdmin: true, active: 'admin' });
}

// ---------------------------------------------------------------------------
// Users — tier management + admin election
// ---------------------------------------------------------------------------
export function renderAdminUsers(args: {
  user: string;
  users: {
    username: string;
    tier: WorkspaceTier;
    hasWorkspace: boolean;
    sharingAllowed: boolean;
  }[];
  extraAdmins: string[];  // emails, portal-elected (admins.users)
  envAdmins: string[];    // emails, from ADMIN_USERS env (fallback/bootstrap)
  hasAdminGroup: boolean; // whether ADMIN_GROUP_OID is configured
}): string {
  const { user, users, extraAdmins, envAdmins, hasAdminGroup } = args;

  const rows = users.map((u) => {
    const isSelf = u.username === user;
    const tierBadge =
      u.tier === 'desktop'
        ? '<span class="role" title="GUI enabled — 3 GB RAM">desktop</span>'
        : '<span class="muted small" title="ttyd + files only — 2 GB RAM">terminal</span>';
    const wsBadge = u.hasWorkspace
      ? '<span class="badge st-running" title="Container exists for this user">yes</span>'
      : '<span class="muted small" title="No container yet — user hasn’t signed in or hasn’t clicked Create">—</span>';
    const sharingBadge = u.sharingAllowed
      ? '<span class="role" title="User can share webapps from their dashboard">on</span>'
      : '<span class="muted small" title="User cannot share — Share buttons hidden from dashboard">off</span>';

    const desktopToggle =
      u.tier === 'desktop'
        ? `<form method="post" action="/admin/users/${esc(u.username)}/disable-desktop" style="display:inline">
             <button title="Drop to terminal-only on next workspace restart.">Disable desktop</button>
           </form>`
        : `<form method="post" action="/admin/users/${esc(u.username)}/enable-desktop" style="display:inline">
             <button title="Enable GUI on next workspace restart.">Enable desktop</button>
           </form>`;

    const sharingToggle =
      u.sharingAllowed
        ? `<form method="post" action="/admin/users/${esc(u.username)}/disallow-sharing" style="display:inline"
                onsubmit="return confirm('Disallow sharing for ${esc(u.username)}? Any webapp URLs they have currently shared will immediately stop working.');">
             <button title="Revoke webapp-sharing capability AND wipe any existing /shared/<user>/p/<port>/ URLs.">Disallow sharing</button>
           </form>`
        : `<form method="post" action="/admin/users/${esc(u.username)}/allow-sharing" style="display:inline">
             <button title="Let this user expose webapp ports at /shared/<user>/p/<port>/ from their dashboard.">Allow sharing</button>
           </form>`;

    return `<tr>
      <td><code>${esc(u.username)}</code>${isSelf ? ' <span class="small muted">(you)</span>' : ''}</td>
      <td>${tierBadge}</td>
      <td>${wsBadge}</td>
      <td>${sharingBadge}</td>
      <td class="actions">${desktopToggle} ${sharingToggle}</td>
    </tr>`;
  }).join('');

  const emptyRow = users.length === 0
    ? `<tr><td colspan="5" class="muted">No users discovered yet. Users appear here the first time they sign in via Entra and click "Create my workspace" on /app.</td></tr>`
    : '';

  // Admins block — list portal-elected admin emails with Revoke buttons,
  // plus a small form to grant admin by email. Also show env/group sources
  // (read-only) so admins understand the full set.
  const adminRows = extraAdmins.length === 0
    ? `<tr><td colspan="2" class="muted">No portal-elected admins yet. Bootstrap admins from <code>ADMIN_USERS</code> env and <code>ADMIN_GROUP_OID</code> are listed below.</td></tr>`
    : extraAdmins.map((e) => `<tr>
        <td><code>${esc(e)}</code></td>
        <td class="actions">
          <form method="post" action="/admin/users/revoke-admin" style="display:inline">
            <input type="hidden" name="email" value="${esc(e)}">
            <button>Revoke admin</button>
          </form>
        </td>
      </tr>`).join('');

  const envAdminList = envAdmins.length
    ? envAdmins.map((e) => `<code>${esc(e)}</code>`).join(', ')
    : '<span class="muted small">(none)</span>';

  const groupNote = hasAdminGroup
    ? 'Members of the Entra security group configured in <code>ADMIN_GROUP_OID</code> are also admin. Manage that group in Entra.'
    : '<code>ADMIN_GROUP_OID</code> is unset — admin status comes only from this list + <code>ADMIN_USERS</code>.';

  const body = `
<section class="container">
  <h2>Admin</h2>
  <p class="lead">User tiers and admin election.</p>
  ${adminSubnav('users')}

  <h3 style="margin-top:24px">Known users</h3>
  <p class="muted small">Tier changes take effect on the next workspace restart — running containers keep their current tier until stopped and started again.</p>
  <table class="admin">
    <thead><tr><th>Username</th><th>Tier</th><th>Workspace</th><th>Sharing</th><th>Actions</th></tr></thead>
    <tbody>${rows}${emptyRow}</tbody>
  </table>

  <h3 style="margin-top:32px">Portal-elected admins</h3>
  <p class="muted small">Grant admin to anyone you've assigned to the ClaudeLab app in Entra. Promotion takes effect on their next page load. Admin status is the union of this list, <code>ADMIN_USERS</code> env, and Entra group membership — any one source makes them admin.</p>
  <table class="admin">
    <thead><tr><th>Email</th><th>Actions</th></tr></thead>
    <tbody>${adminRows}</tbody>
  </table>

  <form method="post" action="/admin/users/grant-admin" class="user-form" style="margin-top:18px;align-items:end;">
    <label style="flex:1;max-width:360px;">
      <span>Email</span>
      <input name="email" type="email" required placeholder="alice@ntiva.com" autocomplete="off" autocapitalize="off">
    </label>
    <button class="cta">Grant admin</button>
  </form>

  <p class="muted small" style="margin-top:24px;">
    <strong>Other admin sources:</strong> ${groupNote}<br>
    <strong>Bootstrap admins (<code>ADMIN_USERS</code> env):</strong> ${envAdminList}.
    These can't be revoked from here — edit <code>.env</code> on the host and restart the portal container.
  </p>
</section>`;
  return layout('Admin — Users', body, { user, isAdmin: true, active: 'admin' });
}

// ---------------------------------------------------------------------------
// Ports — listening sockets across all running workspaces
// ---------------------------------------------------------------------------
export function renderAdminPorts(args: {
  user: string;
  ports: { user: string; port: number; address: string; reachable: boolean }[];
  runningCount: number;
  stoppedCount: number;
}): string {
  const { user, ports, runningCount, stoppedCount } = args;

  const rows = ports.map((p) => {
    const isTtyd = p.port === 7681;
    const isFiles = p.port === 7682;
    const isDesktop = p.port === 7683;
    // From the admin ports view, link via the admin path so the link
    // works for any workspace — the regular /u/<slug>/... routes would
    // re-route to the admin's own workspace, not the target's. Files
    // and desktop links use /u/<slug>/... still since cross-user GUI
    // access for those isn't supported yet (see CLAUDE.md).
    const filesUrl = `/u/${esc(p.user)}/files/`;
    const desktopUrl = `/u/${esc(p.user)}/desktop/`;
    const portUrl = `/admin/term/${esc(p.user)}/p/${p.port}/`;
    const role = isTtyd
      ? '<span class="muted small">terminal (ttyd)</span>'
      : isFiles
      ? '<span class="badge st-running">files</span>'
      : isDesktop
      ? '<span class="badge st-running">desktop</span>'
      : p.reachable
      ? '<span class="badge st-running">webapp</span>'
      : '<span class="muted small">loopback only</span>';
    let link: string;
    if (isTtyd) {
      link = '<code>—</code>';
    } else if (isFiles) {
      link = `<a href="${filesUrl}" target="_blank" rel="noopener"><code>${esc(filesUrl)}</code></a>`;
    } else if (isDesktop) {
      link = `<a href="${desktopUrl}" target="_blank" rel="noopener"><code>${esc(desktopUrl)}</code></a>`;
    } else if (p.reachable) {
      link = `<a href="${portUrl}" target="_blank" rel="noopener"><code>${esc(portUrl)}</code></a>`;
    } else {
      link = `<span class="muted small" title="App is bound to ${esc(p.address)}; bind 0.0.0.0 to be reachable">unreachable — bind 0.0.0.0</span>`;
    }
    return `<tr>
      <td><code>${esc(p.user)}</code></td>
      <td>${p.port}</td>
      <td><code>${esc(p.address)}</code></td>
      <td>${role}</td>
      <td>${link}</td>
    </tr>`;
  }).join('');

  const empty = ports.length === 0
    ? `<tr><td colspan="5" class="muted">No listening sockets in any running workspace.</td></tr>`
    : '';

  const summary = `<p class="muted small">
    ${runningCount} workspace${runningCount === 1 ? '' : 's'} running,
    ${stoppedCount} stopped.
    Loopback-only ports (127.0.0.1) are listed but cannot be reached through the proxy —
    bind <code>0.0.0.0</code> instead.
  </p>`;

  const body = `
<section class="container">
  <div class="admin-head">
    <div>
      <h2>Admin</h2>
      <p class="lead">Listening TCP ports across all workspaces.</p>
    </div>
    <a class="btn-ghost" href="/admin/ports">Refresh</a>
  </div>
  ${adminSubnav('ports')}
  ${summary}
  <table class="admin">
    <thead><tr><th>User</th><th>Port</th><th>Bound to</th><th>Role</th><th>URL</th></tr></thead>
    <tbody>${rows}${empty}</tbody>
  </table>
</section>`;
  return layout('Admin — Ports', body, { user, isAdmin: true, active: 'admin' });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
export function renderLogs(args: { user: string; lines: string[] }): string {
  const body = `
<section class="container">
  <h2>Admin</h2>
  <p class="lead">Recent Caddy access log entries.</p>
  ${adminSubnav('logs')}
  <pre>${esc(args.lines.join('\n'))}</pre>
</section>`;
  return layout('Admin — Logs', body, { user: args.user, isAdmin: true, active: 'admin' });
}

// ---------------------------------------------------------------------------
// Per-user container logs — docker stdout/stderr for ws-<target>
// ---------------------------------------------------------------------------
export function renderAdminUserLogs(args: {
  user: string;
  target: string;
  workspace: WorkspaceInfo;
  logs: string;
  tailLines: number;
}): string {
  const { user, target, workspace, logs, tailLines } = args;
  const statusBadge = `<span class="badge st-${workspace.status}">${workspace.status}</span>`;
  const tierBadge = workspace.containerTier
    ? `<span class="badge st-${workspace.status}">${workspace.containerTier}</span>`
    : '<span class="muted small">—</span>';
  const empty =
    workspace.status === 'absent'
      ? '<p class="muted">No container exists for this user — nothing to log.</p>'
      : !logs.trim()
        ? '<p class="muted">(no log output yet)</p>'
        : '';
  const body = `
<section class="container">
  <div class="admin-head">
    <div>
      <h2>Container logs — <code>${esc(target)}</code></h2>
      <p class="lead">
        Last ${tailLines} lines of <code>docker logs ws-${esc(target)}</code>
        &nbsp;·&nbsp; ${statusBadge} &nbsp;·&nbsp; ${tierBadge}
      </p>
    </div>
    <div>
      <a class="btn-ghost" href="/admin/logs/${esc(target)}?tail=${tailLines}">Refresh</a>
      <a class="btn-ghost" href="/admin">← Back to workspaces</a>
    </div>
  </div>
  ${empty}
  <pre style="max-height:75vh;overflow:auto;">${esc(logs)}</pre>
</section>`;
  return layout(
    `Admin — Logs (${target})`,
    body,
    { user, isAdmin: true, active: 'admin' },
  );
}

// ---------------------------------------------------------------------------
// Cross-user file viewer (Docker-exec backed; sandboxed to /home/node)
// ---------------------------------------------------------------------------
export function renderAdminFiles(args: {
  user: string;
  target: string;
  workspace: WorkspaceInfo;
  path: string;
  entries: DirEntry[];
  error: string | null;
}): string {
  const { user, target, workspace, path: dirPath, entries, error } = args;
  const HOME = '/home/node';
  const statusBadge = `<span class="badge st-${workspace.status}">${workspace.status}</span>`;

  // Breadcrumb path. Each segment links to its prefix.
  const segments = dirPath === HOME ? [] : dirPath.replace(HOME, '').split('/').filter(Boolean);
  const crumbs = [`<a href="/admin/files/${esc(target)}?path=${encodeURIComponent(HOME)}">${esc(HOME)}</a>`];
  let acc = HOME;
  for (const seg of segments) {
    acc = `${acc}/${seg}`;
    crumbs.push(`<a href="/admin/files/${esc(target)}?path=${encodeURIComponent(acc)}">${esc(seg)}</a>`);
  }
  const crumbHtml = crumbs.join(' / ');

  // Parent link (if not at root).
  const parent = dirPath === HOME ? null : posixPath.dirname(dirPath);

  // Table rows.
  const rows = entries.map((e) => {
    const full = `${dirPath}/${e.name}`.replace(/\/+/g, '/');
    if (e.isDir) {
      return `<tr>
        <td>📁 <a href="/admin/files/${esc(target)}?path=${encodeURIComponent(full)}">${esc(e.name)}/</a></td>
        <td class="muted small">—</td>
        <td class="muted small">${esc(e.mtime)}</td>
        <td class="actions"></td>
      </tr>`;
    }
    return `<tr>
      <td>📄 <code>${esc(e.name)}</code></td>
      <td class="muted small">${bytesHuman(e.size)}</td>
      <td class="muted small">${esc(e.mtime)}</td>
      <td class="actions">
        <a class="btn-ghost" href="/admin/files/${esc(target)}/download?path=${encodeURIComponent(full)}">Download</a>
      </td>
    </tr>`;
  }).join('');

  const emptyOrError = error
    ? `<p class="banner banner-error">${esc(error)}</p>`
    : entries.length === 0
      ? '<p class="muted">(empty)</p>'
      : '';

  const body = `
<section class="container">
  <div class="admin-head">
    <div>
      <h2>Files — <code>${esc(target)}</code></h2>
      <p class="lead">${crumbHtml} &nbsp;·&nbsp; ${statusBadge}</p>
    </div>
    <div>
      ${parent ? `<a class="btn-ghost" href="/admin/files/${esc(target)}?path=${encodeURIComponent(parent)}">← Up</a>` : ''}
      <a class="btn-ghost" href="/admin">← Back to workspaces</a>
    </div>
  </div>
  <p class="muted small">Read-only browse via <code>docker exec ls/head</code>. Files larger than 25 MB are truncated on download.</p>
  ${emptyOrError}
  ${entries.length > 0 ? `<table class="admin">
    <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : ''}
</section>`;
  return layout(
    `Admin — Files (${target})`,
    body,
    { user, isAdmin: true, active: 'admin' },
  );
}
