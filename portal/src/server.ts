import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import { config } from './lib/config.js';
import { getUser, requireUser, requireAdmin } from './lib/auth.js';
import {
  ensureWorkspace,
  getWorkspace,
  stopWorkspace,
  destroyWorkspace,
  listWorkspaces,
  workspaceStats,
} from './lib/dockerctl.js';
import { renderMarketing } from './views/marketing.js';
import { renderDashboard } from './views/dashboard.js';
import { renderAdmin, renderLogs } from './views/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: true, // Caddy is in front
  bodyLimit: 1024 * 1024,
});

await app.register(fastifyStatic, {
  root: path.resolve(__dirname, '..', 'public'),
  prefix: '/static/',
  decorateReply: false,
});

// ---------------------------------------------------------------------------
// Public marketing page
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
  const ws = await getWorkspace(u.username);
  reply.type('text/html').send(
    renderDashboard({ user: u.username, isAdmin: u.isAdmin, workspace: ws }),
  );
});

// ---------------------------------------------------------------------------
// Workspace lifecycle (POST + redirect, plain-form-friendly)
// ---------------------------------------------------------------------------
app.post('/api/workspace/start', async (req, reply) => {
  const u = requireUser(req, reply);
  if (!u) return;
  await ensureWorkspace(u.username);
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
  await stopWorkspace(u.username);
  await ensureWorkspace(u.username);
  reply.redirect('/app');
});

// ---------------------------------------------------------------------------
// Admin
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
  await ensureWorkspace(target);
  reply.redirect('/admin');
});

app.post('/admin/workspace/:user/stop', async (req, reply) => {
  const u = requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  await stopWorkspace(target);
  reply.redirect('/admin');
});

app.post('/admin/workspace/:user/destroy', async (req, reply) => {
  const u = requireAdmin(req, reply);
  if (!u) return;
  const target = (req.params as { user: string }).user;
  // Default: keep the volume so we don't nuke user data by accident.
  await destroyWorkspace(target, { keepVolume: true });
  reply.redirect('/admin');
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
