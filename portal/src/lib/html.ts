// Tiny HTML rendering helpers. No templating engine on purpose —
// template literals + an `esc()` for user data is enough at this scale.

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function layout(title: string, body: string, opts: { user?: string; isAdmin?: boolean } = {}): string {
  const nav = opts.user
    ? `<nav>
         <a href="/app">Dashboard</a>
         ${opts.isAdmin ? '<a href="/admin">Admin</a>' : ''}
         <span class="who">${esc(opts.user)}</span>
       </nav>`
    : `<nav><a href="/app">Sign in</a></nav>`;

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
  <div class="brand"><span class="glyph">_$</span> Browser Linux</div>
  ${nav}
</header>
${body}
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
