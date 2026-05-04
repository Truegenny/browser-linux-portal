// Auth contract:
//   Caddy strips/sets X-Auth-User on every authenticated request.
//   The portal trusts that header *only* because it's not exposed to the
//   public network — it's reverse-proxied by Caddy, which is the only
//   ingress. Any direct port exposure on the portal would be a security bug.
//
// Migration to v1.5: oauth2-proxy will set the same X-Auth-User header.
// No code changes here.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

export interface AuthedUser {
  username: string;
  isAdmin: boolean;
}

export function getUser(req: FastifyRequest): AuthedUser | null {
  const raw = req.headers['x-auth-user'];
  if (typeof raw !== 'string' || !raw) return null;
  // Defense in depth: refuse anything that isn't a tame slug.
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(raw)) return null;
  const username = raw.toLowerCase();
  return {
    username,
    isAdmin: config.adminUsers.includes(username),
  };
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): AuthedUser | null {
  const u = getUser(req);
  if (!u) {
    reply.code(401).type('text/plain').send('Unauthorized');
    return null;
  }
  return u;
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): AuthedUser | null {
  const u = requireUser(req, reply);
  if (!u) return null;
  if (!u.isAdmin) {
    reply.code(403).type('text/plain').send('Admins only');
    return null;
  }
  return u;
}
