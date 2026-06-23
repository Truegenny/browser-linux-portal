import { layout, esc } from '../lib/html.js';
import type { WorkspaceInfo, ListeningPort } from '../lib/dockerctl.js';
import type { WorkspaceTier } from '../lib/users.js';

export function renderDashboard(args: {
  user: string;
  email: string;
  isAdmin: boolean;
  workspace: WorkspaceInfo;
  listeningPorts: ListeningPort[];
  tier: WorkspaceTier;
  sharedPorts: Set<number>;
  sharingAllowed: boolean;
}): string {
  const { user, email, isAdmin, workspace, listeningPorts, tier, sharedPorts, sharingAllowed } = args;
  const status = workspace.status;
  // Both desktop (XFCE lite) and power (KDE Plasma) tiers expose a GUI.
  const desktopEnabled = tier === 'desktop' || tier === 'power';

  const tierTitle =
    tier === 'power'
      ? 'KDE Plasma + full Playwright (chromium/firefox/webkit) — 8 GB RAM'
      : tier === 'desktop'
        ? 'XFCE lite GUI — 3 GB RAM'
        : '2 GB RAM, terminal only — ask your admin for the desktop or power tier to get a GUI.';
  const statusBadge = `<span class="badge st-${status}">${status}</span>`;
  const tierBadge = `<span class="badge st-running" title="${tierTitle}">${tier}</span>`;

  const desktopLink = desktopEnabled
    ? `<a class="cta secondary" href="/u/${esc(user)}/desktop/" target="_blank" rel="noopener">Open desktop →</a>`
    : '';

  // Recreate rebuilds the container on the current image (picking up image
  // and HostConfig changes) while preserving the home volume. It's
  // destructive to the container layer, so it always confirms. Shown in both
  // running and stopped states; pointless when absent (Create already builds
  // fresh).
  const recreateBtn = `
         <form method="post" action="/api/workspace/recreate" style="display:inline"
               onsubmit="return confirm('Recreate your workspace on the latest image?\\n\\nYour home directory (/home/node) — repos, configs, ~/.claude — is preserved.\\n\\nAnything OUTSIDE your home directory is lost: system packages installed with sudo apt, global npm tools, and any running processes. Save your work and close sessions first.');">
           <button class="cta secondary" title="Rebuild this workspace on the latest image. Home directory preserved; container-layer changes (system/global packages, files outside ~) are lost.">Recreate</button>
         </form>`;

  const actions =
    status === 'absent'
      ? `<form method="post" action="/api/workspace/start">
           <button class="cta">Create my workspace</button>
         </form>`
      : status === 'stopped'
      ? `<form method="post" action="/api/workspace/start" style="display:inline">
           <button class="cta">Start workspace</button>
         </form>
         ${recreateBtn}`
      : `<a class="cta" href="/u/${esc(user)}/" target="_blank" rel="noopener">Open terminal →</a>
         ${desktopLink}
         <a class="cta secondary" href="/u/${esc(user)}/files/" target="_blank" rel="noopener">Open files →</a>
         <form method="post" action="/api/workspace/stop" style="display:inline">
           <button class="cta secondary">Stop</button>
         </form>
         <form method="post" action="/api/workspace/restart" style="display:inline">
           <button class="cta secondary">Restart</button>
         </form>
         ${recreateBtn}`;

  const meta = `
    <dl class="meta">
      <dt>Container</dt><dd><code>${esc(workspace.containerName)}</code></dd>
      <dt>Volume</dt><dd><code>${esc(workspace.volumeName)}</code></dd>
      <dt>Image</dt><dd><code>${esc(workspace.image ?? '—')}</code></dd>
      <dt>Created</dt><dd>${esc(workspace.createdAt ?? '—')}</dd>
      <dt>Status</dt><dd>${statusBadge}</dd>
      <dt>Tier</dt><dd>${tierBadge}</dd>
    </dl>`;

  // Explain the Recreate button inline (it only appears when a workspace
  // exists). Restart reboots the same container and keeps everything;
  // Recreate rebuilds on the latest image and only preserves the home volume.
  const recreateNote =
    status === 'absent'
      ? ''
      : `
    <details class="card-note" style="margin-top:14px;">
      <summary class="muted small"><strong>Restart</strong> vs <strong>Recreate</strong> — what's kept?</summary>
      <div class="muted small" style="margin-top:8px;line-height:1.5;">
        <p style="margin:0 0 8px;"><strong>Restart</strong> reboots the same container. Everything is kept — use it for a quick reboot.</p>
        <p style="margin:0 0 8px;"><strong>Recreate</strong> rebuilds your workspace on the latest image (this is how you pick up workspace updates). It keeps and loses:</p>
        <p style="margin:0 0 4px;">✅ <strong>Kept:</strong> everything in your home directory <code>/home/node</code> — repos, files, dotfiles, configs, and <code>~/.claude</code>. This lives in your named volume <code>${esc(workspace.volumeName)}</code> and survives.</p>
        <p style="margin:0;">❌ <strong>Lost:</strong> anything outside your home directory — system packages installed with <code>sudo apt</code>, global npm tools (<code>npm i -g</code>), files written to <code>/etc</code>, <code>/opt</code>, etc., and any running processes. Re-run those after recreating. Tip: install global npm tools under <code>~</code> so they persist.</p>
      </div>
    </details>`;

  const tip = `
    <p class="tip">First time? Open the terminal and run <code>claude /login</code> to
    authenticate Claude Code in your browser. After that <code>claude</code> works
    from any session.</p>`;

  // ---------------------------------------------------------------------
  // Paste-ready briefing (collapsed by default)
  // ---------------------------------------------------------------------
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
    </div>`;

  // ---------------------------------------------------------------------
  // Right-hand sidebar: listening ports in this user's container
  // ---------------------------------------------------------------------
  const portRows = listeningPorts
    .map((p) => {
      const isTtyd = p.port === 7681;
      const isFiles = p.port === 7682;
      const isDesktop = p.port === 7683;
      const webappUrl = `/u/${esc(user)}/p/${p.port}/`;
      const filesUrl = `/u/${esc(user)}/files/`;
      const desktopUrl = `/u/${esc(user)}/desktop/`;
      let label: string;
      let body: string;
      let share = '';
      if (isTtyd) {
        label = '<span class="port-tag tag-terminal">terminal</span>';
        body = `<code>${p.port}</code>`;
      } else if (isFiles) {
        label = '<span class="port-tag tag-files">files</span>';
        body = `<a href="${filesUrl}" target="_blank" rel="noopener"><code>${p.port}</code></a>`;
      } else if (isDesktop) {
        label = '<span class="port-tag tag-desktop">desktop</span>';
        body = `<a href="${desktopUrl}" target="_blank" rel="noopener"><code>${p.port}</code></a>`;
      } else if (p.reachable) {
        // Webapp — eligible for sharing. Built-in ports (terminal/files/
        // desktop) are not shareable; sharing is for user-launched servers.
        // Share button is also gated by the admin-managed sharing-allowed
        // list: a user not on that list sees no Share button at all.
        // Already-shared ports still show with an Unshare button regardless
        // so users can revoke their own state, but in practice an admin
        // disabling sharing already wipes the entries.
        label = '<span class="port-tag tag-webapp">webapp</span>';
        body = `<a href="${webappUrl}" target="_blank" rel="noopener"><code>${p.port}</code></a>`;
        const isShared = sharedPorts.has(p.port);
        const shareUrl = `/shared/${esc(user)}/p/${p.port}/`;
        if (isShared) {
          share = `
            <div class="port-share">
              <span class="port-tag tag-shared" title="Reachable to any signed-in Ntiva user at ${shareUrl}">shared</span>
              <form method="post" action="/api/share/${p.port}" style="display:inline">
                <input type="hidden" name="share" value="off">
                <button class="btn-ghost" title="Stop sharing">Unshare</button>
              </form>
              <a class="port-share-link" href="${shareUrl}" target="_blank" rel="noopener" title="Open shared URL"><code>${shareUrl}</code></a>
            </div>`;
        } else if (sharingAllowed) {
          share = `
            <form method="post" action="/api/share/${p.port}" style="display:inline">
              <input type="hidden" name="share" value="on">
              <button class="btn-ghost" title="Make /shared/${esc(user)}/p/${p.port}/ reachable to any signed-in Ntiva user">Share</button>
            </form>`;
        }
        // else: no button. Admin hasn't enabled sharing for this user.
      } else {
        label = '<span class="port-tag tag-loopback">loopback</span>';
        body = `<code title="Bound to ${esc(p.address)}; rebind 0.0.0.0 to expose">${p.port}</code>`;
      }
      return `<li class="port-row">${body}${label}${share}</li>`;
    })
    .join('');

  const portsBody =
    status !== 'running'
      ? '<p class="muted small">Workspace is not running. Start it to see active ports.</p>'
      : listeningPorts.length === 0
      ? '<p class="muted small">Nothing listening yet. Start a server in your workspace, then refresh this page.</p>'
      : `<ul class="ports-list">${portRows}</ul>`;

  const portsSidebar = `
    <aside class="dashboard-side">
      <div class="card ports-card">
        <div class="ports-head">
          <h3 style="margin:0;">Listening ports</h3>
          <a class="btn-ghost" href="/app" title="Refresh">↻</a>
        </div>
        <p class="muted small" style="margin:6px 0 12px;">In <code>${esc(workspace.containerName)}</code></p>
        ${portsBody}
        <p class="muted small" style="margin-top:14px;">
          Ports are scoped to your container — they don't conflict with other users' workspaces, only with your own running services. Loopback ports (<code>127.0.0.1</code>) aren't reachable through the proxy; bind <code>0.0.0.0</code> instead.
        </p>
        ${sharingAllowed
          ? `<p class="muted small">Sharing is enabled for your workspace — click <strong>Share</strong> on any webapp port to expose it at <code>/shared/${esc(user)}/p/&lt;port&gt;/</code> for other signed-in Ntiva users.</p>`
          : `<p class="muted small">Webapp sharing isn't enabled for your workspace. Ask an admin to flip <strong>Allow sharing</strong> for you in <code>/admin/users</code>.</p>`}
      </div>
    </aside>`;

  const body = `
<section class="container">
  <h2>Hello, ${esc(user)}.</h2>
  <p class="lead">Your personal Linux workspace. Signed in as <code>${esc(email)}</code> · <a href="/oauth2/sign_out?rd=/signed-out">sign out</a></p>
  <div class="dashboard-grid">
    <div class="dashboard-main">
      <div class="card">
        <div class="card-row">
          <div>
            <h3>Workspace</h3>
            ${meta}
          </div>
          <div class="actions">${actions}</div>
        </div>
        ${recreateNote}
      </div>
      ${tip}
      ${webappCard}
    </div>
    ${portsSidebar}
  </div>
</section>

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

  return layout(`Dashboard — ${user}`, body, { user, isAdmin, active: 'app' });
}
