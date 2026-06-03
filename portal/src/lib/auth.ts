// Auth contract (v1.0+):
//   Caddy authenticates every request via oauth2-proxy / Entra ID.
//   On success, oauth2-proxy sets X-Auth-Request-* headers; Caddy then
//   re-emits them on the upstream request as:
//     X-Auth-User    — the user's email (lowercased)
//     X-Auth-Groups  — comma-separated Entra group object IDs
//
// The portal trusts these because (a) the portal is never published —
// only Caddy is — and (b) workspace containers live on workspace-net
// which the portal is NOT attached to, so a compromised workspace
// cannot reach portal:3000 to forge headers.
//
// Slug derivation: the workspace identity (container ws-<slug>, volume
// ws-<slug>-home, URL slot /u/<slug>/) is the lowercase local-part of
// the email. justin.cronin@ntiva.com → justin.cronin. Caddy applies
// the same derivation via header_regexp; if these ever diverge, /u/
// would route to a different container than the portal thinks the user
// owns — keep them in sync (see USERNAME_RE in lib/users.ts and the
// header_regexp in Caddyfile).

import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { slugFromEmail } from './users.js';

export interface AuthedUser {
  // Workspace slug — what we use everywhere as the "username".
  username: string;
  // Full email from Entra. Useful for display and audit, not for routing.
  email: string;
  isAdmin: boolean;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function isAdminByGroup(groupsHeader: string | undefined): boolean {
  if (!config.adminGroupOid || !groupsHeader) return false;
  // Entra emits groups as a comma-separated list of GUIDs.
  return groupsHeader.split(',').some((g) => g.trim() === config.adminGroupOid);
}

function isAdminByEnv(email: string): boolean {
  return config.adminUsers.includes(email.toLowerCase());
}

export function getUser(req: FastifyRequest): AuthedUser | null {
  const rawEmail = firstHeader(req.headers['x-auth-user']);
  if (!rawEmail) return null;
  const email = rawEmail.toLowerCase();
  const username = slugFromEmail(email);
  if (!username) return null;
  const groups = firstHeader(req.headers['x-auth-groups']);
  const isAdmin = isAdminByGroup(groups) || isAdminByEnv(email);
  return { username, email, isAdmin };
}

export function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
): AuthedUser | null {
  const u = getUser(req);
  if (!u) {
    reply.code(401).type('text/plain').send('Unauthorized');
    return null;
  }
  return u;
}

export function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): AuthedUser | null {
  const u = requireUser(req, reply);
  if (!u) return null;
  if (!u.isAdmin) {
    reply.code(403).type('text/plain').send('Admins only');
    return null;
  }
  return u;
}
