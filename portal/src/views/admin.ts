import { layout, esc, bytesHuman } from '../lib/html.js';
import type { WorkspaceInfo, DirEntry } from '../lib/dockerctl.js';
import type { WorkspaceTier, Banner, BugReport } from '../lib/users.js';
import type { HostStats } from '../lib/hoststats.js';
import { posix as posixPath } from 'node:path';

type AdminSubTab = 'workspaces' | 'users' | 'ports' | 'logs' | 'banner' | 'host' | 'bugs';

function adminSubnav(active: AdminSubTab, opts: { openBugs?: number } = {}): string {
  const tab = (label: string, href: string, key: AdminSubTab) =>
    `<a class="${active === key ? 'subtab subtab-active' : 'subtab'}" href="${href}">${label}</a>`;
  const bugsLabel =
    opts.openBugs && opts.openBugs > 0 ? `Bugs <span class="count-badge">${opts.openBugs}</span>` : 'Bugs';
  return `<nav class="subtabs">
    ${tab('Workspaces', '/admin', 'workspaces')}
    ${tab('Host', '/admin/host', 'host')}
    ${tab('Users', '/admin/users', 'users')}
    ${tab('Banner', '/admin/banner', 'banner')}
    ${tab(bugsLabel, '/admin/bugs', 'bugs')}
    ${tab('Ports', '/admin/ports', 'ports')}
    ${tab('Logs', '/admin/logs', 'logs')}
  </nav>`;
}

function fmtUptime(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// A labelled usage meter. `pct` 0..100; bar turns amber >75%, red >90%.
function meter(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  const cls = p > 90 ? 'meter-crit' : p > 75 ? 'meter-warn' : 'meter-ok';
  return `<div class="meter"><div class="meter-fill ${cls}" style="width:${p.toFixed(1)}%"></div></div>`;
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
          ${w.containerTier && w.containerTier !== 'terminal'
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

  const tierOption = (current: WorkspaceTier, value: WorkspaceTier, label: string) =>
    `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`;

  const rows = users.map((u) => {
    const isSelf = u.username === user;
    const tierBadge =
      u.tier === 'power'
        ? '<span class="role" title="KDE Plasma + full Playwright (Ubuntu image) — 6 GB RAM">power</span>'
        : u.tier === 'desktop'
          ? '<span class="role" title="XFCE lite GUI — 3 GB RAM">desktop</span>'
          : '<span class="muted small" title="ttyd + files only — 2 GB RAM">terminal</span>';
    const wsBadge = u.hasWorkspace
      ? '<span class="badge st-running" title="Container exists for this user">yes</span>'
      : '<span class="muted small" title="No container yet — user hasn’t signed in or hasn’t clicked Create">—</span>';
    const sharingBadge = u.sharingAllowed
      ? '<span class="role" title="User can share webapps from their dashboard">on</span>'
      : '<span class="muted small" title="User cannot share — Share buttons hidden from dashboard">off</span>';

    // Single 3-way tier selector. The power tier swaps the workspace to the
    // Ubuntu/KDE/Playwright image; switching between any tiers takes effect on
    // the next workspace restart (the home volume is preserved).
    const desktopToggle =
      `<form method="post" action="/admin/users/${esc(u.username)}/tier" style="display:inline-flex;gap:4px;align-items:center"
             title="Change tier. Applies on the user's next workspace restart; the home volume is preserved across the swap.">
         <select name="tier" aria-label="Tier for ${esc(u.username)}">
           ${tierOption(u.tier, 'terminal', 'terminal')}
           ${tierOption(u.tier, 'desktop', 'desktop')}
           ${tierOption(u.tier, 'power', 'power')}
         </select>
         <button>Set tier</button>
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

// ---------------------------------------------------------------------------
// Bugs — user-submitted bug reports
// ---------------------------------------------------------------------------
export function renderAdminBugs(args: { user: string; reports: BugReport[] }): string {
  const { user, reports } = args;
  const open = reports.filter((r) => r.status === 'open').length;

  const rows = reports
    .map((r) => {
      const resolved = r.status === 'resolved';
      const statusBadge = resolved
        ? '<span class="muted small">resolved</span>'
        : '<span class="badge st-running">open</span>';
      const ctx = [
        r.page ? `<div class="muted small">on <code>${esc(r.page)}</code></div>` : '',
        r.userAgent ? `<div class="muted small" title="${esc(r.userAgent)}">UA: ${esc(r.userAgent.slice(0, 60))}${r.userAgent.length > 60 ? '…' : ''}</div>` : '',
      ].join('');
      const toggle = resolved
        ? `<form method="post" action="/admin/bugs/${esc(r.id)}/reopen" style="display:inline">
             <button class="btn-ghost">Reopen</button>
           </form>`
        : `<form method="post" action="/admin/bugs/${esc(r.id)}/resolve" style="display:inline">
             <button class="btn-ghost">Mark resolved</button>
           </form>`;
      return `<tr${resolved ? ' class="muted"' : ''}>
        <td>${statusBadge}</td>
        <td>
          <div style="white-space:pre-wrap;">${esc(r.message)}</div>
          ${ctx}
        </td>
        <td><code>${esc(r.slug)}</code><div class="muted small">${esc(r.email)}</div></td>
        <td class="muted small">${esc(r.createdAt)}</td>
        <td class="actions">
          ${toggle}
          <form method="post" action="/admin/bugs/${esc(r.id)}/delete" style="display:inline"
                onsubmit="return confirm('Delete this report permanently?');">
            <button class="btn-ghost">Delete</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  const empty =
    reports.length === 0
      ? `<tr><td colspan="5" class="muted">No bug reports yet. Users submit them from the “Report a bug” link in the footer.</td></tr>`
      : '';

  const body = `
<section class="container">
  <div class="admin-head">
    <div>
      <h2>Admin</h2>
      <p class="lead">User-submitted bug reports — ${open} open, ${reports.length} total.</p>
    </div>
    <a class="btn-ghost" href="/admin/bugs">Refresh</a>
  </div>
  ${adminSubnav('bugs', { openBugs: open })}
  <table class="admin">
    <thead><tr><th>Status</th><th>Report</th><th>From</th><th>When</th><th>Actions</th></tr></thead>
    <tbody>${rows}${empty}</tbody>
  </table>
</section>`;
  return layout('Admin — Bugs', body, { user, isAdmin: true, active: 'admin' });
}

// ---------------------------------------------------------------------------
// Host — host machine health monitor
// ---------------------------------------------------------------------------
export function renderAdminHost(args: { user: string; host: HostStats }): string {
  const { user, host } = args;

  const memPct = host.memTotal > 0 ? (host.memUsed / host.memTotal) * 100 : 0;
  const diskPct = host.diskTotal > 0 ? (host.diskUsed / host.diskTotal) * 100 : 0;
  const cpuPct = host.cpuPct ?? 0;
  const loadPct = host.cpuCount > 0 ? (host.loadAvg[0] / host.cpuCount) * 100 : 0;

  const cpuValue = host.cpuPct === null ? '—' : `${cpuPct.toFixed(1)}%`;

  const cards = `
  <div class="host-grid">
    <div class="card host-card">
      <h3>CPU</h3>
      <div class="host-stat">${cpuValue}</div>
      ${meter(cpuPct)}
      <p class="muted small">${host.cpuCount} core${host.cpuCount === 1 ? '' : 's'} ·
        load ${host.loadAvg.map((l) => l.toFixed(2)).join(' / ')} (1/5/15m)</p>
      ${meter(loadPct)}
      <p class="muted small">1-min load vs cores</p>
    </div>

    <div class="card host-card">
      <h3>Memory</h3>
      <div class="host-stat">${memPct.toFixed(1)}%</div>
      ${meter(memPct)}
      <p class="muted small">${bytesHuman(host.memUsed)} used / ${bytesHuman(host.memTotal)} total</p>
      <p class="muted small">${bytesHuman(host.memAvailable)} available</p>
    </div>

    <div class="card host-card">
      <h3>Disk</h3>
      <div class="host-stat">${diskPct.toFixed(1)}%</div>
      ${meter(diskPct)}
      <p class="muted small">${bytesHuman(host.diskUsed)} used / ${bytesHuman(host.diskTotal)} total</p>
      <p class="muted small">${bytesHuman(host.diskAvail)} free · <code>${esc(host.diskPath)}</code></p>
    </div>

    <div class="card host-card">
      <h3>Uptime</h3>
      <div class="host-stat">${fmtUptime(host.uptimeSec)}</div>
      <p class="muted small">${host.containersRunning} of ${host.containersTotal} containers running</p>
      <p class="muted small">${host.images} images</p>
    </div>
  </div>`;

  const facts = `
  <table class="admin" style="margin-top:24px;max-width:680px;">
    <tbody>
      <tr><td class="muted">Hostname</td><td><code>${esc(host.hostname)}</code></td></tr>
      <tr><td class="muted">OS</td><td>${esc(host.os)}</td></tr>
      <tr><td class="muted">Kernel</td><td><code>${esc(host.kernel)}</code></td></tr>
      <tr><td class="muted">Docker</td><td><code>${esc(host.dockerVersion)}</code></td></tr>
    </tbody>
  </table>`;

  const body = `
<section class="container">
  <div class="admin-head">
    <div>
      <h2>Admin</h2>
      <p class="lead">Host machine health. <span class="muted small" id="host-refresh-note">auto-refreshing every 10s</span></p>
    </div>
    <a class="btn-ghost" href="/admin/host">Refresh</a>
  </div>
  ${adminSubnav('host')}
  ${cards}
  ${facts}
  <p class="muted small" style="margin-top:18px;">
    CPU is sampled over a short window across all cores. Memory and uptime are
    read from the host (procfs is not container-namespaced); disk reflects the
    filesystem backing <code>${esc(host.diskPath)}</code> on the host.
  </p>
</section>
<script>
  (function () {
    // Auto-refresh the host monitor. Pause when the tab is hidden so we don't
    // sample CPU needlessly in the background.
    var id = setTimeout(function reload() {
      if (!document.hidden) { location.reload(); return; }
      id = setTimeout(reload, 10000);
    }, 10000);
  })();
</script>`;
  return layout('Admin — Host', body, { user, isAdmin: true, active: 'admin' });
}

// ---------------------------------------------------------------------------
// Banner — site-wide announcement editor
// ---------------------------------------------------------------------------
export function renderAdminBanner(args: {
  user: string;
  banner: Banner | null;
}): string {
  const { user, banner } = args;
  const active = banner !== null;
  const level = banner?.level ?? 'info';
  const message = banner?.message ?? '';
  const dismissible = banner ? banner.dismissible : true;

  const levelOption = (value: string, label: string) =>
    `<option value="${value}"${level === value ? ' selected' : ''}>${label}</option>`;

  const status = active
    ? `<p class="banner banner-${level === 'critical' ? 'error' : 'ok'}" style="white-space:pre-wrap;">${esc(message)}</p>
       <p class="muted small">
         Live now · level <strong>${esc(level)}</strong> ·
         ${dismissible ? 'dismissible' : 'pinned (not dismissible)'}
         ${banner?.updatedBy ? ` · last set by <code>${esc(banner.updatedBy)}</code>` : ''}
         ${banner?.updatedAt ? ` · ${esc(banner.updatedAt)}` : ''}
       </p>`
    : '<p class="muted">No banner is currently shown to users.</p>';

  const body = `
<section class="container">
  <h2>Admin</h2>
  <p class="lead">Site-wide announcement banner.</p>
  ${adminSubnav('banner')}

  <h3 style="margin-top:24px">Current banner</h3>
  ${status}

  <h3 style="margin-top:28px">${active ? 'Update' : 'Create'} banner</h3>
  <p class="muted small">
    Shown at the top of every page to all signed-in users, and printed in
    each workspace terminal on every new shell. Use <strong>info</strong>
    for tips, <strong>warning</strong> for upcoming maintenance, <strong>critical</strong>
    for active incidents / forced reboots. Editing the message re-shows it to everyone,
    even those who dismissed the previous one.
  </p>
  <p class="muted small">
    Note: the dismiss toggle only applies to the web banner — the terminal copy
    always shows on a fresh shell. Terminal delivery reaches running workspaces
    immediately; stopped ones pick it up on next start.
  </p>
  <form method="post" action="/admin/banner" class="user-form" style="flex-direction:column;align-items:stretch;max-width:680px;gap:14px;">
    <label>
      <span>Message</span>
      <textarea name="message" rows="3" required maxlength="2000"
        placeholder="e.g. Maintenance window tonight 9–10pm ET — workspaces will be restarted.">${esc(message)}</textarea>
    </label>
    <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:end;">
      <label style="max-width:220px;">
        <span>Level</span>
        <select name="level">
          ${levelOption('info', 'Info (tip / FYI)')}
          ${levelOption('warning', 'Warning (upcoming)')}
          ${levelOption('critical', 'Critical (active incident)')}
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg-soft-2);">
        <input type="checkbox" name="dismissible"${dismissible ? ' checked' : ''}>
        Allow users to dismiss
      </label>
      <button class="cta">${active ? 'Update banner' : 'Publish banner'}</button>
    </div>
  </form>

  ${active
    ? `<form method="post" action="/admin/banner/clear" style="margin-top:16px;"
            onsubmit="return confirm('Remove the banner for all users?');">
         <button class="cta secondary">Clear banner</button>
       </form>`
    : ''}
</section>`;
  return layout('Admin — Banner', body, { user, isAdmin: true, active: 'admin' });
}
