// Tiny HTML rendering helpers. No templating engine on purpose —
// template literals + an `esc()` for user data is enough at this scale.

import { VERSION } from './version.js';

export type Tab = 'home' | 'app' | 'admin';

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function layout(
  title: string,
  body: string,
  opts: { user?: string; isAdmin?: boolean; active?: Tab } = {},
): string {
  const tab = (label: string, href: string, key: Tab) => {
    const cls = opts.active === key ? 'tab tab-active' : 'tab';
    return `<a class="${cls}" href="${href}">${label}</a>`;
  };

  // Home is always visible. Admin appears only for admins. Sign-in
  // shows up when no one is signed in.
  const tabs: string[] = [tab('Home', '/', 'home')];
  if (opts.user) {
    tabs.push(tab('Dashboard', '/app', 'app'));
    if (opts.isAdmin) tabs.push(tab('Admin', '/admin', 'admin'));
  } else {
    tabs.push(`<a class="tab" href="/app">Sign in</a>`);
  }

  const who = opts.user
    ? `<span class="who">
         ${esc(opts.user)}${opts.isAdmin ? ' <span class="role">admin</span>' : ''}
         <a class="signout" href="/logout" title="Sign out">Sign out</a>
       </span>`
    : '';

  // Anti-FOUC: read the persisted theme from localStorage and set
  // data-theme on <html> BEFORE the body renders. Runs synchronously.
  const earlyThemeScript = `
<script>
(function(){
  try {
    var t = localStorage.getItem('blp.theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) {}
})();
</script>`;

  // Toggle: SVGs for sun/moon. CSS swaps which is visible by data-theme.
  const themeToggle = `
<button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle light/dark theme" title="Toggle theme">
  <svg class="icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
  <svg class="icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>
</button>`;

  const toggleScript = `
<script>
(function(){
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', function(){
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    var next = cur === 'light' ? 'dark' : 'light';
    if (next === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', next);
    }
    try { localStorage.setItem('blp.theme', next); } catch (e) {}
  });
})();
</script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${earlyThemeScript}
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<header class="site">
  <a class="brand" href="/"><span class="glyph">_$</span> Browser Linux</a>
  <nav class="tabs">${tabs.join('')}</nav>
  ${who}
  ${themeToggle}
</header>
${body}
<footer class="site">
  <div>
    Browser Linux — self-hosted dev workspaces.
    Built on Caddy + Docker + ttyd + Claude Code.
  </div>
  <div class="version">v${esc(VERSION)}</div>
</footer>
${toggleScript}
</body>
</html>`;
}

export function bytesHuman(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
