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
} from './lib/dockerctl.js';
import {
  setUserTier,
  getUserTier,
  listDesktopUsers,
  USERNAME_RE,
} from './lib/users.js';
import { renderMarketing } from './views/marketing.js';
import { renderDashboard } from './views/dashboard.js';
import {
  renderAdmin,
  renderLogs,
  renderAdminUsers,
  renderAdminPorts,
  renderAdminUserLogs,
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
  const u = getUser(req);
  reply.type('text/html').send(
    renderMarketing({ user: u?.username, isAdmin: u?.isAdmin }),
  );
});

app.get('/favicon.ico', async (_req, reply) => {
  reply.code(204).send();
});

app.get('/robots.txt', async (_req, reply) => {
  reply.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// ---------------------------------------------------------------------------
// Authenticated dashboard
// ---------------------------------------------------------------------------
app.get('/app', async (req, reply) => {
  const u = requireUser(req, reply);
  if (!u) return;
  const [ws, tier] = await Promise.all([
    getWorkspace(u.username),
    getUserTier(u.username),
  ]);
  const listeningPorts =
    ws.status === 'running'
      ? await listListeningPorts(u.username).catch(() => [])
      : [];
  reply.type('text/html').send(
    renderDashboard({
      user: u.username,
      email: u.email,
      isAdmin: u.isAdmin,
      workspace: ws,
      listeningPorts,
      tier,
    }),
  );
});

// ---------------------------------------------------------------------------
// Workspace lifecycle (POST + redirect, plain-form-friendly)
// ---------------------------------------------------------------------------
app.post('/api/workspace/start', async (req, reply) => {
  const u = requireUser(req, reply);
  if (!u) return;
  const tier = await getUserTier(u.username);
  await ensureWorkspace(u.username, { tier });
  reply.redirect('/app');
});

app.post('/api/workspace/stop', async (req, reply) => {
  const u = requireUser(req, reply);
  if (!u) return;
  await stopWorkspace(u.username);
  reply.redirect('/app');
});

app.post('/api/workspace/restart', async (req, reply) => {
  const u = requireUser(req, reply);
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
  const u = requireAdmin(req, reply);
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
  const u = requireAdmin(req, reply);
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
  const u = requireAdmin(req, reply);
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
  const u = requireAdmin(req, reply);
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
  const u = requireAdmin(req, reply);
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
  const u = requireAdmin(req, reply);
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
  const u = requireAdmin(req, reply);
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
  const u = requireAdmin(req, reply);
  if (!u) return;
  const [workspaces, desktopUsers] = await Promise.all([
    listWorkspaces(),
    listDesktopUsers(),
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
    renderAdminUsers({ user: u.username, users }),
  );
});

app.post('/admin/users/:target/enable-desktop', async (req, reply) => {
  const u = requireAdmin(req, reply);
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
  const u = requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { target: string }).target;
  if (!USERNAME_RE.test(target)) {
    reply.code(400).type('text/plain').send('Invalid username.');
    return;
  }
  await setUserTier(target, 'terminal');
  reply.redirect('/admin/users');
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
