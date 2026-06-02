// CSRF protection for state-changing requests.
//
// Auth is HTTP Basic, which browsers attach automatically on every
// cross-origin request to a realm they've signed into. Without this hook,
// any tab the user has open could submit a hidden <form action="…/admin/
// users/admin/delete"> and the browser would dutifully attach the cached
// credentials.
//
// Strategy:
//   1. Fast path — if Sec-Fetch-Site is present (all current browsers send
//      it on every request), require same-origin or none (typed URL /
//      bookmark / programmatic by the user). Reject same-site and
//      cross-site outright.
//   2. Fallback — if Sec-Fetch-Site is absent but Origin is set, compare
//      Origin against the effective request origin (rebuilt from the
//      X-Forwarded-{Proto,Host} headers Caddy passes through).
//   3. If neither header is set, the caller is a non-browser client
//      (curl from the host, an internal script). CSRF doesn't apply to
//      those because the attack vector is a browser sending a request
//      with the user's cached creds — allow through.
//
// Goes away in v1.5: oauth2-proxy wraps every state-changing request in
// a session cookie + SameSite=Lax / token check anyway.

import type { FastifyReply, FastifyRequest } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function expectedOrigin(req: FastifyRequest): string {
  const proto = firstHeader(req.headers['x-forwarded-proto']) ?? 'http';
  const host =
    firstHeader(req.headers['x-forwarded-host']) ??
    firstHeader(req.headers.host) ??
    '';
  return `${proto}://${host}`;
}

export async function csrfGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (SAFE_METHODS.has(req.method)) return;

  const site = firstHeader(req.headers['sec-fetch-site']);
  if (site !== undefined) {
    if (site === 'same-origin' || site === 'none') return;
    reply.code(403).type('text/plain').send('Cross-origin request blocked.');
    return;
  }

  // Older browser without Sec-Fetch-Site, but still a browser — check Origin.
  const origin = firstHeader(req.headers.origin);
  if (origin !== undefined) {
    if (origin !== expectedOrigin(req)) {
      reply.code(403).type('text/plain').send('Cross-origin request blocked.');
      return;
    }
  }
  // No browser CSRF headers at all → non-browser client (curl/script). Allow.
}
