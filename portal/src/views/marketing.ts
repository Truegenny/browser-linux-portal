// The public landing page. Hand-written in the LinuxOnTab style:
// dark theme, hero, features grid, vs-table, FAQ, footer.

import { layout } from '../lib/html.js';

export function renderMarketing(opts: { user?: string; isAdmin?: boolean }): string {
  const cta = opts.user
    ? `<a class="cta" href="/app">Open dashboard →</a>`
    : `<a class="cta" href="/app">Sign in →</a>`;

  const body = `
<section class="hero">
  <h1><span class="glyph">_$</span> Real Linux. In a browser tab.<br>Self-hosted. Persistent. <em>Yours.</em></h1>
  <p class="lead">
    A self-hosted dev workspace platform: each authorized user gets a real
    Debian Linux container with <strong>Claude Code</strong> preinstalled,
    accessible from any browser, with state that survives between sessions.
  </p>
  <div class="cta-row">
    ${cta}
    <a class="cta secondary" href="#features">How it works</a>
  </div>
  <div class="badges">
    <span>Real Debian + Node 20</span>
    <span>Claude Code preinstalled</span>
    <span>Persistent /home</span>
    <span>SSO-ready (v1.5)</span>
  </div>
</section>

<section id="what" class="container">
  <h2>What this is</h2>
  <p>
    Browser Linux is a small, self-hosted alternative to Coder, Codespaces,
    and Gitpod. One Linux VM, one Docker daemon, a per-user container with
    a persistent home volume — and a browser-based terminal that drops you
    straight into <code>bash</code>, with <code>claude</code> already on
    <code>$PATH</code>.
  </p>
  <p>
    Unlike LinuxOnTab and WebVM-style projects, this isn't a kernel running
    in WebAssembly. It's a real Linux container on real hardware you control.
    That trade buys you 64-bit, full networking, and the ability to actually
    run modern toolchains — Node, Python, Go, Rust, and the Claude CLI.
  </p>
</section>

<section id="features" class="container">
  <h2>Features</h2>
  <div class="grid">
    <div class="card"><h3>Real Linux container</h3><p>Debian 12 + Node 20 + sudo + apt. Full networking, full toolchain, no WebAssembly tradeoffs.</p></div>
    <div class="card"><h3>Claude Code preinstalled</h3><p>The <code>claude</code> CLI is on every workspace's <code>$PATH</code>. <code>claude /login</code> once and you're in.</p></div>
    <div class="card"><h3>Persistent /home</h3><p>Your home directory lives in a Docker volume keyed to your identity. Restart, reboot, redeploy — your files stay.</p></div>
    <div class="card"><h3>Browser terminal</h3><p>xterm.js + ttyd over WebSocket. Copy/paste works. Mobile-usable.</p></div>
    <div class="card"><h3>Per-user isolation</h3><p>You can only access your own workspace, enforced at the proxy. No way to peek at someone else's box.</p></div>
    <div class="card"><h3>Resource limits</h3><p>Each workspace is capped at configurable CPU and RAM so one runaway process can't take down the host.</p></div>
    <div class="card"><h3>Idle-stop</h3><p>Stale workspaces stop themselves to free resources. Volumes persist; the container is recreated on next login.</p></div>
    <div class="card"><h3>Admin console</h3><p>Built-in <code>/admin</code> page — see who's running what, force-stop workspaces, tail the access log.</p></div>
    <div class="card"><h3>Self-hosted</h3><p>Ships as a docker-compose stack. Runs on a single $20/month Azure VM. No SaaS, no telemetry.</p></div>
  </div>
</section>

<section id="vs" class="container">
  <h2>vs Coder / Codespaces / WebVM</h2>
  <table>
    <thead><tr><th></th><th>Browser Linux</th><th>Coder OSS</th><th>GitHub Codespaces</th><th>WebVM</th></tr></thead>
    <tbody>
      <tr><td>Self-hosted</td>           <td class="yes">Yes</td><td class="yes">Yes</td><td class="no">No (SaaS)</td><td class="yes">Yes</td></tr>
      <tr><td>Real 64-bit Linux</td>     <td class="yes">Yes</td><td class="yes">Yes</td><td class="yes">Yes</td><td class="no">x86 32-bit (WASM)</td></tr>
      <tr><td>Persistent state</td>      <td class="yes">Volume per user</td><td class="yes">Volume / disk</td><td class="yes">Codespace</td><td>IndexedDB</td></tr>
      <tr><td>Claude Code OOTB</td>      <td class="yes">Preinstalled</td><td>Module</td><td>Manual</td><td class="no">Not really</td></tr>
      <tr><td>Setup complexity</td>      <td class="yes">One docker-compose</td><td>Real install</td><td class="yes">Click</td><td>Custom build</td></tr>
      <tr><td>Best for</td>              <td>Small teams self-hosting on Azure</td><td>Bigger teams, multi-host</td><td>Projects in GitHub</td><td>Disposable demos</td></tr>
    </tbody>
  </table>
</section>

<section id="faq" class="container">
  <h2>FAQ</h2>
  <details><summary>Is this production-ready?</summary><p>v0–v1 is targeted at small trusted teams behind basicauth. v1.5 adds Entra ID SSO. v2+ adds RBAC and audit log.</p></details>
  <details><summary>How do users authenticate?</summary><p>Today: HTTP basic auth (one bcrypt hash per user, stored in a file Caddy reads). v1.5: OIDC against Microsoft Entra ID.</p></details>
  <details><summary>Where do my files live?</summary><p>In a Docker named volume on the host (<code>ws-&lt;user&gt;-home</code>) mounted at <code>/home/node</code> inside the container. Back it up with <code>tar</code>.</p></details>
  <details><summary>Can users break out of the container?</summary><p>The same risk model as any sudo-enabled container: assume yes if they're motivated. Don't host this in front of untrusted users. For trusted teammates, the kernel sandbox is acceptable.</p></details>
  <details><summary>Does it run offline?</summary><p>The site is on your VM, so you need to reach the VM. The Anthropic API is online-only — <code>claude</code> needs internet.</p></details>
</section>

`;
  return layout('Browser Linux', body, { ...opts, active: 'home' });
}
