import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyFormbody from '@fastify/formbody';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import { config } from './lib/config.js';
import { csrfGuard } from './lib/csrf.js';
import { getUser, requireUser, requireAdmin } from './lib/auth.js';
import {
  ensureWorkspace,
  getWorkspace,
  stopWorkspace,
  destroyWorkspace,
  listWorkspaces,
  workspaceStats,
  listListeningPorts,
  getContainerLogs,
  listContainerDir,
  readContainerFile,
} from './lib/dockerctl.js';
import {
  setUserTier,
  getUserTier,
  listDesktopUsers,
  listExtraAdminEmails,
  setExtraAdmin,
  listSharedPorts,
  isShared,
  setShared,
  USERNAME_RE,
} from './lib/users.js';
import { renderMarketing, renderSignedOut } from './views/marketing.js';
import { renderDashboard } from './views/dashboard.js';
import {
  renderAdmin,
  renderLogs,
  renderAdminUsers,
  renderAdminPorts,
  renderAdminUserLogs,
  renderAdminFiles,
} from './views/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: true, // Caddy is in front
  bodyLimit: 1024 * 1024,
});

// Reject cross-origin state-changing requests before any body parsing or
// route handling runs. See lib/csrf.ts for the rationale.
app.addHook('onRequest', csrfGuard);

// Parse application/x-www-form-urlencoded so plain HTML <form method="post">
// submissions (Stop / Restart / desktop-toggle buttons) don't 415.
await app.register(fastifyFormbody);

await app.register(fastifyStatic, {
  root: path.resolve(__dirname, '..', 'public'),
  prefix: '/static/',
  decorateReply: false,
});

// ---------------------------------------------------------------------------
// Public marketing page (still gated by Caddy/oauth2-proxy in production;
// anyone reaching it is already authenticated)
// ---------------------------------------------------------------------------
app.get('/', async (req, reply) => {
  const u = await getUser(req);
  reply.type('text/html').send(
    renderMarketing({ user: u?.username, isAdmin: u?.isAdmin }),
  );
});

app.get('/favicon.ico', async (_req, reply) => {
  reply.code(204).send();
});

// Post-sign-out landing page. Caddy excludes this path from forward_auth so
// the user doesn't get silently re-authenticated the moment the cookie is
// cleared. See views/marketing.ts::renderSignedOut for the rationale.
app.get('/signed-out', async (_req, reply) => {
  reply.type('text/html').send(renderSignedOut());
});

app.get('/robots.txt', async (_req, reply) => {
  reply.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// ---------------------------------------------------------------------------
// Authenticated dashboard
// ---------------------------------------------------------------------------
app.get('/app', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const [ws, tier, allShared] = await Promise.all([
    getWorkspace(u.username),
    getUserTier(u.username),
    listSharedPorts(),
  ]);
  const listeningPorts =
    ws.status === 'running'
      ? await listListeningPorts(u.username).catch(() => [])
      : [];
  const sharedPortsSet = new Set(
    allShared.filter((s) => s.sharer === u.username).map((s) => s.port),
  );
  reply.type('text/html').send(
    renderDashboard({
      user: u.username,
      email: u.email,
      isAdmin: u.isAdmin,
      workspace: ws,
      listeningPorts,
      tier,
      sharedPorts: sharedPortsSet,
    }),
  );
});

// ---------------------------------------------------------------------------
// Workspace lifecycle (POST + redirect, plain-form-friendly)
// ---------------------------------------------------------------------------
app.post('/api/workspace/start', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const tier = await getUserTier(u.username);
  await ensureWorkspace(u.username, { tier });
  reply.redirect('/app');
});

app.post('/api/workspace/stop', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  await stopWorkspace(u.username);
  reply.redirect('/app');
});

app.post('/api/workspace/restart', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const tier = await getUserTier(u.username);
  await stopWorkspace(u.username);
  await ensureWorkspace(u.username, { tier });
  reply.redirect('/app');
});

// ---------------------------------------------------------------------------
// Admin — workspaces
// ---------------------------------------------------------------------------
app.get('/admin', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const workspaces = await listWorkspaces();
  // Pull stats in parallel; tolerate failures.
  const enriched = await Promise.all(
    workspaces.map(async (w) => ({
      ...w,
      stats:
        w.status === 'running'
          ? await workspaceStats(w.user).catch(() => null)
          : null,
    })),
  );
  reply.type('text/html').send(renderAdmin({ user: u.username, workspaces: enriched }));
});

app.post('/admin/workspace/:user/start', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  const tier = await getUserTier(target);
  await ensureWorkspace(target, { tier });
  reply.redirect('/admin');
});

app.post('/admin/workspace/:user/stop', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  await stopWorkspace(target);
  reply.redirect('/admin');
});

app.post('/admin/workspace/:user/destroy', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  const body = (req.body ?? {}) as { wipe_volume?: string };
  const keepVolume = body.wipe_volume !== 'on';
  await destroyWorkspace(target, { keepVolume });
  reply.redirect('/admin');
});

app.get('/admin/ports', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const workspaces = await listWorkspaces();
  const running = workspaces.filter((w) => w.status === 'running');
  const portRows = (
    await Promise.all(
      running.map((w) => listListeningPorts(w.user).catch(() => [])),
    )
  ).flat();
  reply.type('text/html').send(
    renderAdminPorts({
      user: u.username,
      ports: portRows,
      runningCount: running.length,
      stoppedCount: workspaces.length - running.length,
    }),
  );
});

app.get('/admin/logs', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const logPath = '/var/log/caddy/access.log';
  let lines: string[] = [];
  try {
    const data = await fs.readFile(logPath, 'utf8');
    lines = data.trim().split('\n').slice(-200);
  } catch (e: any) {
    lines = [`(could not read ${logPath}: ${e.message})`];
  }
  reply.type('text/html').send(renderLogs({ user: u.username, lines }));
});

// Per-user container logs — Docker stdout/stderr for ws-<target>.
app.get('/admin/logs/:user', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  const tailRaw = (req.query as { tail?: string }).tail;
  const tailLines = Math.min(Math.max(parseInt(tailRaw ?? '', 10) || 500, 50), 5000);
  const [workspace, logs] = await Promise.all([
    getWorkspace(target),
    getContainerLogs(target, { tailLines }).catch(
      (e: any) => `(failed to read container logs: ${e.message ?? e})`,
    ),
  ]);
  reply.type('text/html').send(
    renderAdminUserLogs({
      user: u.username,
      target,
      workspace,
      logs,
      tailLines,
    }),
  );
});

// ---------------------------------------------------------------------------
// Admin — tier management
// ---------------------------------------------------------------------------
// No user CRUD anymore — identity is owned by Entra. This page lists every
// user the portal currently knows about (union of existing workspace
// containers + entries in desktop.users) and lets the admin toggle the
// desktop tier per user. New users appear automatically the first time
// they sign in and create a workspace.
app.get('/admin/users', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const [workspaces, desktopUsers, extraAdmins] = await Promise.all([
    listWorkspaces(),
    listDesktopUsers(),
    listExtraAdminEmails(),
  ]);
  const set = new Set<string>(workspaces.map((w) => w.user));
  desktopUsers.forEach((d) => set.add(d));
  const desktopSet = new Set(desktopUsers);
  const users = Array.from(set)
    .sort((a, b) => a.localeCompare(b))
    .map((username) => ({
      username,
      tier: (desktopSet.has(username) ? 'desktop' : 'terminal') as
        | 'desktop'
        | 'terminal',
      hasWorkspace: workspaces.some((w) => w.user === username),
    }));
  reply.type('text/html').send(
    renderAdminUsers({
      user: u.username,
      users,
      extraAdmins,
      envAdmins: config.adminUsers,
      hasAdminGroup: !!config.adminGroupOid,
    }),
  );
});

app.post('/admin/users/:target/enable-desktop', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { target: string }).target;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  await setUserTier(target, 'desktop');
  reply.redirect('/admin/users');
});

app.post('/admin/users/:target/disable-desktop', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { target: string }).target;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  await setUserTier(target, 'terminal');
  reply.redirect('/admin/users');
});

// Promote / demote portal-elected admins. Keyed by email rather than slug
// because admin status is a property of identity (Entra email), not of the
// workspace slug — different users can theoretically share a slug if they
// were ever to live in different tenants.
app.post('/admin/users/grant-admin', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const body = (req.body ?? {}) as { email?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    reply.code(400).type('text/plain').send('Invalid email.');
    return;
  }
  await setExtraAdmin(email, true);
  reply.redirect('/admin/users');
});

app.post('/admin/users/revoke-admin', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const body = (req.body ?? {}) as { email?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  if (!email) {
    reply.code(400).type('text/plain').send('Invalid email.');
    return;
  }
  if (email === u.email) {
    // Allow self-demotion only if another admin source still applies;
    // otherwise the user would lock themselves out.
    reply.code(400).type('text/plain').send(
      "Refusing to revoke your own portal-elected admin status. Demote yourself by removing your entry from caddy/admins.users on the host, or have another admin do it.",
    );
    return;
  }
  await setExtraAdmin(email, false);
  reply.redirect('/admin/users');
});

// ---------------------------------------------------------------------------
// Admin — cross-user file viewer (Docker exec, read-only)
// ---------------------------------------------------------------------------
// Filebrowser can't be reached cross-user because it bakes /u/<self>/files
// into the URLs it serves, so we use the Docker socket to list directories
// and stream files. Sandboxed to /home/node — the same volume regular
// filebrowser exposes — and admin-gated.
app.get('/admin/files/:user', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  const dirPath = ((req.query as { path?: string }).path ?? '/home/node').trim();
  let entries: Array<{ name: string; isDir: boolean; size: number; mtime: string }> = [];
  let error: string | null = null;
  try {
    entries = await listContainerDir(target, dirPath);
  } catch (e: any) {
    error = e?.message ?? String(e);
  }
  const ws = await getWorkspace(target);
  reply.type('text/html').send(
    renderAdminFiles({
      user: u.username,
      target,
      workspace: ws,
      path: dirPath,
      entries,
      error,
    }),
  );
});

app.get('/admin/files/:user/download', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  const filePath = ((req.query as { path?: string }).path ?? '').trim();
  if (!filePath) {
    reply.code(400).type('text/plain').send('Missing path.');
    return;
  }
  try {
    const { data, truncated } = await readContainerFile(target, filePath);
    const basename = filePath.split('/').pop() || 'file';
    reply
      .header('Content-Type', 'application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename="${basename.replace(/"/g, '')}"`,
      );
    if (truncated) reply.header('X-File-Truncated', 'true');
    reply.send(data);
  } catch (e: any) {
    reply.code(400).type('text/plain').send(`Failed: ${e?.message ?? e}`);
  }
});

// ---------------------------------------------------------------------------
// Webapp sharing — per-user toggle from the dashboard sidebar.
// ---------------------------------------------------------------------------
app.post('/api/share/:port', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const port = parseInt((req.params as { port: string }).port, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    reply.code(400).type('text/plain').send('Invalid port.');
    return;
  }
  const body = (req.body ?? {}) as { share?: string };
  // Toggle: empty/false = revoke, anything truthy = share.
  const shouldShare = body.share === 'on' || body.share === '1' || body.share === 'true';
  await setShared(u.username, port, shouldShare);
  reply.redirect('/app');
});

// ---------------------------------------------------------------------------
// Internal — share check endpoint for Caddy's forward_auth subrequest.
// ---------------------------------------------------------------------------
// Caddy hits this before proxying /shared/<sharer>/p/<port>/. Auth is
// already required (any signed-in user passes the outer forward_auth),
// so we just confirm the requested (sharer, port) is in shared.ports.
app.get('/internal/check-shared', async (req, reply) => {
  // Outer forward_auth already verified the requester is signed in.
  const u = await getUser(req);
  if (!u) {
    reply.code(403).type('text/plain').send('not authenticated');
    return;
  }
  const sharer = String(req.headers['x-share-sharer'] ?? '').toLowerCase();
  const port = parseInt(String(req.headers['x-share-port'] ?? ''), 10);
  if (!sharer || !Number.isFinite(port)) {
    reply.code(400).type('text/plain').send('missing share params');
    return;
  }
  const ok = await isShared(sharer, port);
  reply.code(ok ? 200 : 403).type('text/plain').send(ok ? 'shared' : 'not shared');
});

// ---------------------------------------------------------------------------
// Internal — admin check endpoint for Caddy's forward_auth subrequest.
// ---------------------------------------------------------------------------
// Caddy hits this before proxying /admin/term/<target>/* to the workspace
// container. We can't gate that at Caddy level by header alone anymore
// because portal-elected admins live in a file Caddy doesn't read.
// Returns 200 if the request identity is admin (group OR file OR env),
// 403 otherwise. Headers come from Caddy via the inner forward_auth's
// header_up directives.
app.get('/internal/check-admin', async (req, reply) => {
  const u = await getUser(req);
  if (!u) {
    reply.code(403).type('text/plain').send('not authenticated');
    return;
  }
  if (!u.isAdmin) {
    reply.code(403).type('text/plain').send('not admin');
    return;
  }
  reply.code(200).type('text/plain').send('admin');
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/healthz', async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const start = async () => {
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(
      {
        port: config.port,
        domain: config.domain,
        admins: config.adminUsers,
        adminGroup: config.adminGroupOid || '(none — using ADMIN_USERS only)',
      },
      'portal up',
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
