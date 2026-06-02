import { layout, esc, bytesHuman } from '../lib/html.js';
import type { WorkspaceInfo } from '../lib/dockerctl.js';
import type { WorkspaceTier } from '../lib/users.js';

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
// Users
// ---------------------------------------------------------------------------
export function renderAdminUsers(args: {
  user: string;
  users: { username: string; isAdmin: boolean; tier: WorkspaceTier }[];
  message: string | null;
  error: string | null;
}): string {
  const { user, users, message, error } = args;

  const rows = users.map((u) => {
    const isSelf = u.username === user;
    const adminBadge = u.isAdmin
      ? '<span class="role">admin</span>'
      : '<span class="muted small">—</span>';

    const tierBadge =
      u.tier === 'desktop'
        ? '<span class="role" title="GUI enabled — 3 GB RAM">desktop</span>'
        : '<span class="muted small" title="ttyd + files only — 2 GB RAM">terminal</span>';

    const desktopToggle =
      u.tier === 'desktop'
        ? `<form method="post" action="/admin/users/${esc(u.username)}/disable-desktop" style="display:inline">
             <button title="Drop to terminal-only on next workspace restart.">Disable desktop</button>
           </form>`
        : `<form method="post" action="/admin/users/${esc(u.username)}/enable-desktop" style="display:inline">
             <button title="Enable GUI on next workspace restart.">Enable desktop</button>
           </form>`;

    const demoteAttr = isSelf
      ? 'disabled title="You cannot demote yourself."'
      : '';
    const promoteOrDemote = u.isAdmin
      ? `<form method="post" action="/admin/users/${esc(u.username)}/demote" style="display:inline">
           <button ${demoteAttr}>Demote</button>
         </form>`
      : `<form method="post" action="/admin/users/${esc(u.username)}/promote" style="display:inline">
           <button>Promote to admin</button>
         </form>`;

    const deleteForm = isSelf
      ? '<button disabled title="You cannot delete yourself.">Delete</button>'
      : `<form method="post" action="/admin/users/${esc(u.username)}/delete" style="display:inline"
              onsubmit="return confirm('Delete user ${esc(u.username)}? Workspace data is preserved unless you check the wipe box.');">
           <label style="font-size:11px;color:#8a929e;display:inline-flex;align-items:center;gap:3px;margin-right:4px">
             <input type="checkbox" name="wipe_workspace"> wipe workspace
           </label>
           <button>Delete</button>
         </form>`;

    return `<tr>
      <td><code>${esc(u.username)}</code>${isSelf ? ' <span class="small muted">(you)</span>' : ''}</td>
      <td>${adminBadge}</td>
      <td>${tierBadge}</td>
      <td class="actions">${desktopToggle} ${promoteOrDemote} ${deleteForm}</td>
    </tr>`;
  }).join('');

  const emptyRow = users.length === 0
    ? `<tr><td colspan="4" class="muted">No users yet. Add one below.</td></tr>`
    : '';

  const banner = error
    ? `<p class="banner banner-error">${esc(error)}</p>`
    : message
    ? `<p class="banner banner-ok">${esc(message)}</p>`
    : '';

  const body = `
<section class="container">
  <h2>Admin</h2>
  <p class="lead">Manual user management. <strong>Temporary</strong> — gone in v1.5 when Entra SSO replaces basic auth.</p>
  ${adminSubnav('users')}
  ${banner}

  <h3 style="margin-top:24px">Existing users</h3>
  <p class="muted small">Tier changes take effect on the next workspace restart — running containers keep their current tier until stopped and started again.</p>
  <table class="admin">
    <thead><tr><th>Username</th><th>Role</th><th>Tier</th><th>Actions</th></tr></thead>
    <tbody>${rows}${emptyRow}</tbody>
  </table>

  <h3 style="margin-top:32px">Add or reset a user</h3>
  <p class="muted small">If the username already exists, the password is reset. The admin and desktop checkboxes set the user's current state; leaving them unchecked drops the user back to non-admin / terminal-only.</p>
  <form method="post" action="/admin/users/add" class="user-form">
    <label>
      <span>Username</span>
      <input name="username" type="text" required pattern="[a-z0-9][a-z0-9_-]{0,30}"
             placeholder="alice" autocomplete="off" autocapitalize="off">
    </label>
    <label>
      <span>Password</span>
      <input name="password" type="password" required minlength="8"
             placeholder="at least 8 characters" autocomplete="new-password">
    </label>
    <label class="checkbox">
      <input name="is_admin" type="checkbox">
      <span>grant admin role</span>
    </label>
    <label class="checkbox">
      <input name="enable_desktop" type="checkbox">
      <span>enable desktop GUI (3 GB RAM instead of 2 GB)</span>
    </label>
    <button class="cta">Save user</button>
  </form>
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
    const filesUrl = `/u/${esc(p.user)}/files/`;
    const desktopUrl = `/u/${esc(p.user)}/desktop/`;
    const portUrl = `/u/${esc(p.user)}/p/${p.port}/`;
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
