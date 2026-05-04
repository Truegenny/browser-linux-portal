import { layout, esc } from '../lib/html.js';
import type { WorkspaceInfo } from '../lib/dockerctl.js';

export function renderDashboard(args: {
  user: string;
  isAdmin: boolean;
  workspace: WorkspaceInfo;
}): string {
  const { user, isAdmin, workspace } = args;
  const status = workspace.status;

  const statusBadge = `<span class="badge st-${status}">${status}</span>`;

  const actions =
    status === 'absent'
      ? `<form method="post" action="/api/workspace/start">
           <button class="cta">Create my workspace</button>
         </form>`
      : status === 'stopped'
      ? `<form method="post" action="/api/workspace/start">
           <button class="cta">Start workspace</button>
         </form>`
      : `<a class="cta" href="/u/${esc(user)}/" target="_blank" rel="noopener">Open terminal →</a>
         <form method="post" action="/api/workspace/stop" style="display:inline">
           <button class="cta secondary">Stop</button>
         </form>
         <form method="post" action="/api/workspace/restart" style="display:inline">
           <button class="cta secondary">Restart</button>
         </form>`;

  const meta = `
    <dl class="meta">
      <dt>Container</dt><dd><code>${esc(workspace.containerName)}</code></dd>
      <dt>Volume</dt><dd><code>${esc(workspace.volumeName)}</code></dd>
      <dt>Image</dt><dd><code>${esc(workspace.image ?? '—')}</code></dd>
      <dt>Created</dt><dd>${esc(workspace.createdAt ?? '—')}</dd>
      <dt>Status</dt><dd>${statusBadge}</dd>
    </dl>`;

  const tip = `
    <p class="tip">First time? Open the terminal and run <code>claude /login</code> to
    authenticate Claude Code in your browser. After that <code>claude</code> works
    from any session.</p>`;

  const body = `
<section class="container">
  <h2>Hello, ${esc(user)}.</h2>
  <p class="lead">Your personal Linux workspace.</p>
  <div class="card">
    <div class="card-row">
      <div>
        <h3>Workspace</h3>
        ${meta}
      </div>
      <div class="actions">${actions}</div>
    </div>
  </div>
  ${tip}
</section>`;

  return layout(`Dashboard — ${user}`, body, { user, isAdmin, active: 'app' });
}
