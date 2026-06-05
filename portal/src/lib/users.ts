// Per-user portal state. Identity itself comes from Entra ID via
// oauth2-proxy (X-Auth-User header set by Caddy from
// X-Auth-Request-Email), so there's no user CRUD in this file —
// no bcrypt, no password files. We manage two state files here:
//
//   /caddy/desktop.users  — slugs whose workspace runs the GUI tier
//   /caddy/admins.users   — emails who are admins by portal election
//                           (in addition to the Entra group OID and
//                            the ADMIN_USERS env var, both unioned)
//
// Slug shape: the local-part of the user's email, lowercased. Dots are
// allowed (justin.cronin@ntiva.com → justin.cronin). The same regex
// gates URL slots in Caddy (handle_path /u/*) and admin-only paths
// (/admin/term/<target>/*) so malformed slugs never reach Docker.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const CADDY_DIR = '/caddy';
const DESKTOP_FILE = path.join(CADDY_DIR, 'desktop.users');
const ADMINS_FILE = path.join(CADDY_DIR, 'admins.users');
const SHARED_FILE = path.join(CADDY_DIR, 'shared.ports');
const SHARING_ALLOWED_FILE = path.join(CADDY_DIR, 'sharing-allowed.users');

export type WorkspaceTier = 'terminal' | 'desktop';

// Lowercase a-z, digits, with `.`, `-`, `_`. Must start with [a-z0-9].
// 1..41 chars total. Matches the regex baked into Caddyfile's path_regexp
// for /u/* and /admin/term/* — keep them in sync.
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/;

export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name);
}

// Derive the workspace slug from an Entra-issued email. Returns null if
// the local-part doesn't conform to the regex (e.g. contains characters
// Docker won't accept in container names).
export function slugFromEmail(email: string): string | null {
  const at = email.indexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at).toLowerCase();
  return USERNAME_RE.test(local) ? local : null;
}

// ---------------------------------------------------------------------------
// desktop.users — plain one-username-per-line, presence == GUI enabled.
// ---------------------------------------------------------------------------
async function readPlainList(file: string): Promise<string[]> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    out.push(line);
  }
  return out;
}

async function writePlainList(file: string, names: string[]): Promise<void> {
  const header =
    '# Users with the desktop GUI enabled. Managed by the portal /admin/users UI.\n' +
    '# One username per line. Caddy never reads this file.\n';
  const body = Array.from(new Set(names))
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
  await fs.writeFile(file, header + body + '\n', 'utf8');
}

export async function listDesktopUsers(): Promise<string[]> {
  return readPlainList(DESKTOP_FILE);
}

export async function getUserTier(username: string): Promise<WorkspaceTier> {
  const desktop = await readPlainList(DESKTOP_FILE);
  return desktop.includes(username) ? 'desktop' : 'terminal';
}

export async function setUserTier(
  username: string,
  tier: WorkspaceTier,
): Promise<void> {
  if (!isValidUsername(username)) throw new Error('Invalid username');
  const desktop = await readPlainList(DESKTOP_FILE);
  const filtered = desktop.filter((u) => u !== username);
  if (tier === 'desktop') filtered.push(username);
  await writePlainList(DESKTOP_FILE, filtered);
}

// ---------------------------------------------------------------------------
// admins.users — emails of users elected to admin by another admin from
// the /admin/users UI. Unioned with the Entra group OID check and the
// ADMIN_USERS env var; any one of the three makes a user admin.
// ---------------------------------------------------------------------------
function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export async function listExtraAdminEmails(): Promise<string[]> {
  const raw = await readPlainList(ADMINS_FILE);
  return raw.map(normalizeEmail).filter(Boolean);
}

export async function isExtraAdmin(email: string): Promise<boolean> {
  const list = await listExtraAdminEmails();
  return list.includes(normalizeEmail(email));
}

// ---------------------------------------------------------------------------
// shared.ports — webapp ports that users have opted to expose to any other
// signed-in user via /shared/<sharer>/p/<port>/. Format: <sharer>:<port>
// per line. Caddy doesn't read this file; the portal's
// /internal/check-shared endpoint validates each request via Caddy's
// forward_auth subrequest.
// ---------------------------------------------------------------------------
export interface SharedPort {
  sharer: string;
  port: number;
}

export async function listSharedPorts(): Promise<SharedPort[]> {
  const raw = await readPlainList(SHARED_FILE);
  const out: SharedPort[] = [];
  for (const line of raw) {
    const sep = line.indexOf(':');
    if (sep < 1) continue;
    const sharer = line.slice(0, sep).trim().toLowerCase();
    const port = parseInt(line.slice(sep + 1).trim(), 10);
    if (!isValidUsername(sharer) || !Number.isFinite(port) || port <= 0 || port > 65535) continue;
    out.push({ sharer, port });
  }
  return out;
}

export async function isShared(sharer: string, port: number): Promise<boolean> {
  const list = await listSharedPorts();
  return list.some((s) => s.sharer === sharer.toLowerCase() && s.port === port);
}

async function writeSharedFile(list: SharedPort[]): Promise<void> {
  const header =
    '# Webapp sharing. Managed by the /app dashboard share toggles.\n' +
    '# Format: <sharer>:<port> per line. Caddy never reads this file —\n' +
    '# /internal/check-shared on the portal answers Caddy via forward_auth.\n';
  const body = Array.from(
    new Set(list.map((s) => `${s.sharer}:${s.port}`)),
  )
    .sort()
    .join('\n');
  await fs.writeFile(SHARED_FILE, header + body + '\n', 'utf8');
}

export async function setShared(
  sharer: string,
  port: number,
  shared: boolean,
): Promise<void> {
  if (!isValidUsername(sharer)) throw new Error('Invalid sharer');
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port');
  }
  const list = await listSharedPorts();
  const filtered = list.filter(
    (s) => !(s.sharer === sharer && s.port === port),
  );
  if (shared) filtered.push({ sharer, port });
  await writeSharedFile(filtered);
}

// ---------------------------------------------------------------------------
// sharing-allowed.users — admin-managed allowlist of users who can use the
// dashboard's per-port Share button. Default-off: a fresh user can run
// webapps but can't expose them via /shared/<sharer>/p/<port>/ until an
// admin grants the capability. Disallowing also revokes any existing shares
// for that user, so disable acts as a kill-switch.
// ---------------------------------------------------------------------------
export async function listSharingAllowed(): Promise<string[]> {
  return readPlainList(SHARING_ALLOWED_FILE);
}

export async function isSharingAllowed(slug: string): Promise<boolean> {
  const list = await listSharingAllowed();
  return list.includes(slug);
}

export async function setSharingAllowed(
  slug: string,
  allowed: boolean,
): Promise<void> {
  if (!isValidUsername(slug)) throw new Error('Invalid username');
  const list = await listSharingAllowed();
  const filtered = list.filter((u) => u !== slug);
  if (allowed) filtered.push(slug);
  const header =
    '# Users allowed to share webapps from their dashboard. Managed by the\n' +
    '# /admin/users UI. Default-off: a user not in this list sees no Share\n' +
    '# buttons and their POSTs to /api/share/:port return 403.\n';
  const body = Array.from(new Set(filtered))
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
  await fs.writeFile(SHARING_ALLOWED_FILE, header + body + '\n', 'utf8');

  // When disallowing, also wipe any existing share entries for this user
  // so an admin's "disable sharing" acts as an immediate kill-switch on
  // any currently-live share URLs.
  if (!allowed) {
    const shared = await listSharedPorts();
    const cleaned = shared.filter((s) => s.sharer !== slug);
    if (cleaned.length !== shared.length) {
      await writeSharedFile(cleaned);
    }
  }
}

export async function setExtraAdmin(
  email: string,
  isAdmin: boolean,
): Promise<void> {
  const norm = normalizeEmail(email);
  if (!norm.includes('@') || norm.length < 3) {
    throw new Error('Invalid email');
  }
  const list = await listExtraAdminEmails();
  const filtered = list.filter((e) => e !== norm);
  if (isAdmin) filtered.push(norm);
  // Reuse the desktop.users writer style — a plain header + sorted list.
  // Slightly different header text since the file's purpose is different.
  const header =
    '# Portal-elected admins. Managed by the /admin/users UI.\n' +
    '# One email per line. Unioned with ADMIN_GROUP_OID and ADMIN_USERS env.\n';
  const body = Array.from(new Set(filtered))
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
  await fs.writeFile(ADMINS_FILE, header + body + '\n', 'utf8');
}
