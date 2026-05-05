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

  // Paste-ready instructions for Claude Code running inside the workspace.
  // Plain text (no markdown rendering) so it copies cleanly into a chat.
  const claudeBriefing = `# Hosting a webapp from this workspace

This container sits behind a Caddy reverse proxy on the host VM. READ THIS
BEFORE proposing any approach to making a webapp reachable from outside.

## URL pattern (the only thing that works)

  http://<vm-host>:8080/u/${user}/p/<port>/

Replace <port> with whatever TCP port your app binds to. The <vm-host> is
the host's public IP or DNS name (the user already knows it).

## Requirements

1. Bind to 0.0.0.0:<port>, NOT 127.0.0.1 or localhost.
   Verify with: ss -tln | grep <port>   (look for 0.0.0.0:<port> or *:<port>)
2. Pick any port >= 1024 — root is not available, not needed.
3. If your HTML uses absolute URLs (href="/foo", src="/bar.js"), add this
   to <head> so they resolve through the proxy:
     <base href="/u/${user}/p/<port>/">
   Otherwise use relative URLs throughout.
4. WebSockets, SSE, HTTP/2 all work — Caddy auto-upgrades. Same-origin,
   so no CORS to worry about.

## DO NOT suggest

- "docker run -p <port>:<port>" — workspaces are not republished.
- New Azure NSG inbound rules — only 8080 is open and that is enough.
- SSH tunnels — already proxied through 8080.
- Listening on port 80 — root unavailable, not needed.
- Tailscale / ngrok / cloudflared — overkill, the proxy already does this.

## Multiple webapps

Run as many as you like on different ports; each gets its own URL:
  /u/${user}/p/3000/   /u/${user}/p/8000/   /u/${user}/p/47291/

## Security

The proxy is auth-gated by the same basic-auth that lets the user reach
this dashboard. Routing is by authenticated identity, not URL slot, so
cross-user access is impossible.
`;

  const webappCard = `
    <div class="card" style="margin-top:18px;">
      <h3>Hosting a webapp from your workspace</h3>
      <p class="muted small" style="margin:6px 0 12px;">Bind your dev server / API / app to <code>0.0.0.0:&lt;port&gt;</code> inside the workspace, then open:</p>
      <pre style="margin:0;"><code>/u/${esc(user)}/p/&lt;port&gt;/</code></pre>
      <p class="muted small" style="margin:12px 0 0;">
        Example: a server on port 8000 becomes
        <code>/u/${esc(user)}/p/8000/</code>. WebSockets work.
        Use relative links in your HTML, or add
        <code>&lt;base href="/u/${esc(user)}/p/&lt;port&gt;/"&gt;</code> if your app uses absolute paths.
      </p>

      <details style="margin-top:14px;">
        <summary>Paste this into Claude inside your workspace</summary>
        <p class="muted small" style="margin:8px 0;">Future Claude sessions don't know about the proxy by default. Paste this block into the chat the first time you ask Claude to build or expose a webapp — it covers the URL pattern, the bind-on-0.0.0.0 requirement, and the things <em>not</em> to try (port publish, NSG rules, SSH tunnels).</p>
        <div class="copy-wrap">
          <button type="button" class="btn-ghost copy-btn" data-copy-target="claude-briefing">Copy</button>
          <pre id="claude-briefing" class="claude-briefing">${esc(claudeBriefing)}</pre>
        </div>
      </details>
    </div>

    <script>
      (function () {
        document.querySelectorAll('button.copy-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-copy-target');
            var el = document.getElementById(id);
            if (!el) return;
            var text = el.textContent || '';
            var done = function () {
              var orig = btn.textContent;
              btn.textContent = 'Copied!';
              btn.classList.add('copy-ok');
              setTimeout(function () {
                btn.textContent = orig;
                btn.classList.remove('copy-ok');
              }, 1400);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(done).catch(function () {});
            } else {
              // Fallback for older browsers / non-secure contexts
              var ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              try { document.execCommand('copy'); done(); } catch (e) {}
              document.body.removeChild(ta);
            }
          });
        });
      })();
    </script>`;

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
  ${webappCard}
</section>`;

  return layout(`Dashboard — ${user}`, body, { user, isAdmin, active: 'app' });
}
