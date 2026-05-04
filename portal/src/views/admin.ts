import { layout, esc, bytesHuman } from '../lib/html.js';
import type { WorkspaceInfo } from '../lib/dockerctl.js';

type AdminSubTab = 'workspaces' | 'users' | 'logs';

function adminSubnav(active: AdminSubTab): string {
  const tab = (label: string, href: string, key: AdminSubTab) =>
    `<a class="${active === key ? 'subtab subtab-active' : 'subtab'}" href="${href}">${label}</a>`;
  return `<nav class="subtabs">
    ${tab('Workspaces', '/admin', 'workspaces')}
    ${tab('Users', '/admin/users', 'users')}
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
      return `<tr>
        <td><code>${esc(w.user)}</code></td>
        <td><span class="badge st-${w.status}">${w.status}</span></td>
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
    ? `<tr><td colspan="7" class="muted">No workspaces yet. They appear after a user signs in and clicks Create.</td></tr>`
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
      <tr><th>User</th><th>Status</th><th>Image</th><th>Created</th><th>CPU</th><th>Mem</th><th>Actions</th></tr>
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
  users: { username: string; isAdmin: boolean }[];
  message: string | null;
  error: string | null;
}): string {
  const { user, users, message, error } = args;

  const rows = users.map((u) => {
    const isSelf = u.username === user;
    const adminBadge = u.isAdmin
      ? '<span class="role">admin</span>'
      : '<span class="muted small">—</span>';

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
      <td class="actions">${promoteOrDemote} ${deleteForm}</td>
    </tr>`;
  }).join('');

  const emptyRow = users.length === 0
    ? `<tr><td colspan="3" class="muted">No users yet. Add one below.</td></tr>`
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
  <table class="admin">
    <thead><tr><th>Username</th><th>Role</th><th>Actions</th></tr></thead>
    <tbody>${rows}${emptyRow}</tbody>
  </table>

  <h3 style="margin-top:32px">Add or reset a user</h3>
  <p class="muted small">If the username already exists, the password is reset.</p>
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
    <button class="cta">Save user</button>
  </form>
</section>`;
  return layout('Admin — Users', body, { user, isAdmin: true, active: 'admin' });
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
