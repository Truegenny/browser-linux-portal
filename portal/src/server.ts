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
} from './lib/dockerctl.js';
import {
  listUsers,
  addOrUpdateUser,
  setAdmin,
  deleteUser,
  USERNAME_RE,
} from './lib/users.js';
import { renderMarketing } from './views/marketing.js';
import { renderDashboard } from './views/dashboard.js';
import {
  renderAdmin,
  renderLogs,
  renderAdminUsers,
  renderAdminPorts,
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
// submissions (Create / Stop / Restart / user-management buttons) don't 415.
await app.register(fastifyFormbody);

await app.register(fastifyStatic, {
  root: path.resolve(__dirname, '..', 'public'),
  prefix: '/static/',
  decorateReply: false,
});

// ---------------------------------------------------------------------------
// Public marketing page
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

app.get('/robots.txt', async (_req, reply) => {
  reply.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// ---------------------------------------------------------------------------
// Authenticated dashboard
// ---------------------------------------------------------------------------
app.get('/app', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  const ws = await getWorkspace(u.username);
  const listeningPorts =
    ws.status === 'running'
      ? await listListeningPorts(u.username).catch(() => [])
      : [];
  reply.type('text/html').send(
    renderDashboard({
      user: u.username,
      isAdmin: u.isAdmin,
      workspace: ws,
      listeningPorts,
    }),
  );
});

// ---------------------------------------------------------------------------
// Workspace lifecycle (POST + redirect, plain-form-friendly)
// ---------------------------------------------------------------------------
app.post('/api/workspace/start', async (req, reply) => {
  const u = await requireUser(req, reply);
  if (!u) return;
  await ensureWorkspace(u.username);
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
  await stopWorkspace(u.username);
  await ensureWorkspace(u.username);
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
  await ensureWorkspace(target);
  reply.redirect('/admin');
});

app.post('/admin/workspace/:user/stop', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  await stopWorkspace(target);
  reply.redirect('/admin');
});

app.post('/admin/workspace/:user/destroy', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
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
  // Pull ports from each running workspace in parallel; tolerate failures.
  const portRows = (
    await Promise.all(
      running.map((w) =>
        listListeningPorts(w.user).catch(() => []),
      ),
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

// ---------------------------------------------------------------------------
// Admin — users (manual management; gone in v1.5)
// ---------------------------------------------------------------------------
app.get('/admin/users', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const users = await listUsers();
  reply.type('text/html').send(
    renderAdminUsers({ user: u.username, users, message: null, error: null }),
  );
});

app.post('/admin/users/add', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const body = (req.body ?? {}) as {
    username?: string;
    password?: string;
    is_admin?: string;
  };
  const username = (body.username ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const wantAdmin = body.is_admin === 'on';

  let error: string | null = null;
  if (!USERNAME_RE.test(username)) error = `Invalid username "${username}".`;
  if (password.length < 8) error = 'Password must be at least 8 characters.';

  if (error) {
    const users = await listUsers();
    reply.type('text/html').send(
      renderAdminUsers({ user: u.username, users, message: null, error }),
    );
    return;
  }

  try {
    await addOrUpdateUser(username, password, wantAdmin);
  } catch (e: any) {
    const users = await listUsers();
    reply.type('text/html').send(
      renderAdminUsers({
        user: u.username,
        users,
        message: null,
        error: e.message ?? String(e),
      }),
    );
    return;
  }
  reply.redirect('/admin/users');
});

app.post('/admin/users/:target/promote', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { target: string }).target;
  await setAdmin(target, true);
  reply.redirect('/admin/users');
});

app.post('/admin/users/:target/demote', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { target: string }).target;
  if (target === u.username) {
    reply.code(400).type('text/plain').send("You can't demote yourself.");
    return;
  }
  await setAdmin(target, false);
  reply.redirect('/admin/users');
});

app.post('/admin/users/:target/delete', async (req, reply) => {
  const u = await requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { target: string }).target;
  if (target === u.username) {
    reply.code(400).type('text/plain').send("You can't delete yourself.");
    return;
  }
  const body = (req.body ?? {}) as { wipe_workspace?: string };
  if (body.wipe_workspace === 'on') {
    await destroyWorkspace(target, { keepVolume: false }).catch(() => {
      // If destroy fails (e.g. no workspace ever existed), proceed with delete.
    });
  }
  await deleteUser(target);
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
      { port: config.port, domain: config.domain, admins: config.adminUsers },
      'portal up',
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
