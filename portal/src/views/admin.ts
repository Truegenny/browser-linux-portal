import { layout, esc, bytesHuman } from '../lib/html.js';
import type { WorkspaceInfo } from '../lib/dockerctl.js';

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
          <form method="post" action="/admin/workspace/${esc(w.user)}/stop"   style="display:inline"><button>Stop</button></form>
          <form method="post" action="/admin/workspace/${esc(w.user)}/start"  style="display:inline"><button>Start</button></form>
          <form method="post" action="/admin/workspace/${esc(w.user)}/destroy" style="display:inline"
                onsubmit="return confirm('Destroy ${esc(w.user)}\\'s container? Volume kept by default.')"><button>Destroy</button></form>
        </td>
      </tr>`;
    })
    .join('');

  const empty = workspaces.length === 0
    ? `<tr><td colspan="7" class="muted">No workspaces yet. They appear after a user signs in and clicks Create.</td></tr>`
    : '';

  const body = `
<section class="container">
  <h2>Admin</h2>
  <p class="lead">All workspaces on this host.</p>
  <table class="admin">
    <thead>
      <tr><th>User</th><th>Status</th><th>Image</th><th>Created</th><th>CPU</th><th>Mem</th><th>Actions</th></tr>
    </thead>
    <tbody>${rows}${empty}</tbody>
  </table>
  <p class="muted small">Logs: <a href="/admin/logs">access log</a></p>
</section>`;
  return layout('Admin', body, { user, isAdmin: true, active: 'admin' });
}

export function renderLogs(args: { user: string; lines: string[] }): string {
  const body = `
<section class="container">
  <h2>Access log (tail)</h2>
  <pre>${esc(args.lines.join('\n'))}</pre>
  <p><a href="/admin">← Back to admin</a></p>
</section>`;
  return layout('Admin logs', body, { user: args.user, isAdmin: true, active: 'admin' });
}
