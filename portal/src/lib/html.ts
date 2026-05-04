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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<header class="site">
  <a class="brand" href="/"><span class="glyph">_$</span> Browser Linux</a>
  <nav class="tabs">${tabs.join('')}</nav>
  ${who}
</header>
${body}
<footer class="site">
  <div>
    Browser Linux — self-hosted dev workspaces.
    Built on Caddy + Docker + ttyd + Claude Code.
  </div>
  <div class="version">v${esc(VERSION)}</div>
</footer>
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
