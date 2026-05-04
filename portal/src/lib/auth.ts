// Auth contract:
//   Caddy strips/sets X-Auth-User on every authenticated request.
//   The portal trusts that header *only* because it's not exposed to the
//   public network — it's reverse-proxied by Caddy, which is the only
//   ingress. Any direct port exposure on the portal would be a security bug.
//
// Admin status: sourced from caddy/admins.users (file authority). The
// ADMIN_USERS env var is honored as a *fallback* so the very first admin
// can sign in even if the admins.users file is empty (e.g. on a fresh
// stack where add-user.sh hasn't run yet).
//
// Migration to v1.5: oauth2-proxy will set the same X-Auth-User header.
// The admin source becomes Entra group membership; this file logic gets
// deleted along with the basic_auth UI.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { isAdminFromFile } from './users.js';

export interface AuthedUser {
  username: string;
  isAdmin: boolean;
}

function readUsername(req: FastifyRequest): string | null {
  const raw = req.headers['x-auth-user'];
  if (typeof raw !== 'string' || !raw) return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(raw)) return null;
  return raw.toLowerCase();
}

export async function getUser(req: FastifyRequest): Promise<AuthedUser | null> {
  const username = readUsername(req);
  if (!username) return null;
  let isAdmin = config.adminUsers.includes(username); // env fallback
  try {
    if (await isAdminFromFile(username)) isAdmin = true;
  } catch {
    // If the admins.users file isn't readable, fall back to env-only.
  }
  return { username, isAdmin };
}

export async function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthedUser | null> {
  const u = await getUser(req);
  if (!u) {
    reply.code(401).type('text/plain').send('Unauthorized');
    return null;
  }
  return u;
}

export async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthedUser | null> {
  const u = await requireUser(req, reply);
  if (!u) return null;
  if (!u.isAdmin) {
    reply.code(403).type('text/plain').send('Admins only');
    return null;
  }
  return u;
}
