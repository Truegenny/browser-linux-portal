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
import { randomUUID } from 'node:crypto';

const CADDY_DIR = '/caddy';
const DESKTOP_FILE = path.join(CADDY_DIR, 'desktop.users');
const POWER_FILE = path.join(CADDY_DIR, 'power.users');
const ADMINS_FILE = path.join(CADDY_DIR, 'admins.users');
const SHARED_FILE = path.join(CADDY_DIR, 'shared.ports');
const SHARING_ALLOWED_FILE = path.join(CADDY_DIR, 'sharing-allowed.users');
const BANNER_FILE = path.join(CADDY_DIR, 'banner.json');
const BUGS_FILE = path.join(CADDY_DIR, 'bug-reports.json');

// Three tiers, in ascending resource order:
//   terminal — ttyd + filebrowser only (Debian image, no GUI started)
//   desktop  — adds the XFCE4 lite GUI         (Debian image, ENABLE_DESKTOP=1)
//   power    — KDE Plasma + full Playwright     (Ubuntu power image)
// Membership lives in two plain files: presence in power.users wins, else
// presence in desktop.users, else terminal. See getUserTier.
export type WorkspaceTier = 'terminal' | 'desktop' | 'power';

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

const DESKTOP_HEADER =
  '# Users with the desktop (lite/XFCE) GUI enabled. Managed by the portal\n' +
  '# /admin/users UI. One username per line. Caddy never reads this file.\n';
const POWER_HEADER =
  '# Users on the POWER tier (Ubuntu image: KDE Plasma + full Playwright).\n' +
  '# Managed by the portal /admin/users UI. Presence here wins over\n' +
  '# desktop.users. One username per line. Caddy never reads this file.\n';

async function writePlainList(
  file: string,
  names: string[],
  header: string,
): Promise<void> {
  const body = Array.from(new Set(names))
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
  await fs.writeFile(file, header + body + '\n', 'utf8');
}

export async function listDesktopUsers(): Promise<string[]> {
  return readPlainList(DESKTOP_FILE);
}

export async function listPowerUsers(): Promise<string[]> {
  return readPlainList(POWER_FILE);
}

// Resolve a user's tier. Power wins over desktop wins over terminal so a user
// can never be ambiguously in two tiers at once even if both files name them.
export async function getUserTier(username: string): Promise<WorkspaceTier> {
  const [power, desktop] = await Promise.all([
    readPlainList(POWER_FILE),
    readPlainList(DESKTOP_FILE),
  ]);
  if (power.includes(username)) return 'power';
  if (desktop.includes(username)) return 'desktop';
  return 'terminal';
}

// Set a user's tier by reconciling membership across both files: a user is in
// exactly one of {power.users, desktop.users, neither}. Writing 'power' also
// removes them from desktop.users (and vice versa) so the two files never both
// name the same user.
export async function setUserTier(
  username: string,
  tier: WorkspaceTier,
): Promise<void> {
  if (!isValidUsername(username)) throw new Error('Invalid username');
  const [power, desktop] = await Promise.all([
    readPlainList(POWER_FILE),
    readPlainList(DESKTOP_FILE),
  ]);
  const powerOut = power.filter((u) => u !== username);
  const desktopOut = desktop.filter((u) => u !== username);
  if (tier === 'power') powerOut.push(username);
  if (tier === 'desktop') desktopOut.push(username);
  await Promise.all([
    writePlainList(POWER_FILE, powerOut, POWER_HEADER),
    writePlainList(DESKTOP_FILE, desktopOut, DESKTOP_HEADER),
  ]);
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

// ---------------------------------------------------------------------------
// banner.json — a single site-wide announcement banner shown to all signed-in
// users on every page (rendered client-side from GET /api/banner). Managed by
// admins from /admin/banner. Use cases: maintenance windows, forced-reboot
// notices, tips. `level` drives the colour; `dismissible` lets info/tips be
// dismissed (per-user, via localStorage keyed to `updatedAt`) while a critical
// maintenance notice can be pinned. Editing the message bumps `updatedAt`, so
// a changed banner re-appears for everyone who had dismissed the previous one.
// ---------------------------------------------------------------------------
export type BannerLevel = 'info' | 'warning' | 'critical';

export interface Banner {
  message: string;
  level: BannerLevel;
  dismissible: boolean;
  updatedAt: string;     // ISO timestamp; doubles as the dismissal key
  updatedBy?: string;    // admin email, for the admin view only
}

function coerceLevel(v: unknown): BannerLevel {
  return v === 'warning' || v === 'critical' ? v : 'info';
}

// Returns the active banner, or null if none is set / the file is empty or
// malformed. Tolerant by design — a broken banner.json must never 500 a page.
export async function getBanner(): Promise<Banner | null> {
  let raw: string;
  try {
    raw = await fs.readFile(BANNER_FILE, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    return null;
  }
  try {
    const b = JSON.parse(raw);
    const message = typeof b?.message === 'string' ? b.message.trim() : '';
    if (!message) return null;
    return {
      message,
      level: coerceLevel(b.level),
      dismissible: b.dismissible !== false,
      updatedAt: typeof b.updatedAt === 'string' ? b.updatedAt : '',
      updatedBy: typeof b.updatedBy === 'string' ? b.updatedBy : undefined,
    };
  } catch {
    return null;
  }
}

export async function setBanner(args: {
  message: string;
  level: string;
  dismissible: boolean;
  updatedBy?: string;
}): Promise<void> {
  const message = args.message.trim();
  if (!message) throw new Error('Banner message is empty');
  if (message.length > 2000) throw new Error('Banner message too long (max 2000 chars)');
  const payload: Banner = {
    message,
    level: coerceLevel(args.level),
    dismissible: args.dismissible,
    updatedAt: new Date().toISOString(),
    updatedBy: args.updatedBy,
  };
  await fs.writeFile(BANNER_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export async function clearBanner(): Promise<void> {
  // Truncate to an empty message rather than unlink — getBanner() treats an
  // empty message as "no banner", and keeping the file avoids ENOENT churn.
  await fs.writeFile(
    BANNER_FILE,
    JSON.stringify({ message: '', level: 'info', dismissible: true, updatedAt: '' }, null, 2) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// bug-reports.json — user-submitted bug reports, shown to admins under
// /admin/bugs. A JSON array (low volume, team-scale). Newest reports are
// appended; the file is capped to the most recent MAX_BUGS so it can't grow
// unbounded. Admins mark reports resolved or delete them.
// ---------------------------------------------------------------------------
const MAX_BUGS = 500;

export type BugStatus = 'open' | 'resolved';

export interface BugReport {
  id: string;
  slug: string;        // reporter workspace slug
  email: string;       // reporter email
  message: string;
  page?: string;       // page the user was on when reporting
  userAgent?: string;
  createdAt: string;   // ISO
  status: BugStatus;
}

async function readBugs(): Promise<BugReport[]> {
  let raw: string;
  try {
    raw = await fs.readFile(BUGS_FILE, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    return [];
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r.id === 'string' && typeof r.message === 'string')
      .map((r) => ({
        id: r.id,
        slug: typeof r.slug === 'string' ? r.slug : 'unknown',
        email: typeof r.email === 'string' ? r.email : '',
        message: String(r.message),
        page: typeof r.page === 'string' ? r.page : undefined,
        userAgent: typeof r.userAgent === 'string' ? r.userAgent : undefined,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
        status: r.status === 'resolved' ? 'resolved' : 'open',
      }));
  } catch {
    return [];
  }
}

async function writeBugs(list: BugReport[]): Promise<void> {
  await fs.writeFile(BUGS_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
}

// Reports newest-first for display.
export async function listBugReports(): Promise<BugReport[]> {
  const list = await readBugs();
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function addBugReport(input: {
  slug: string;
  email: string;
  message: string;
  page?: string;
  userAgent?: string;
}): Promise<BugReport> {
  const message = input.message.trim();
  if (!message) throw new Error('Report message is empty');
  if (message.length > 5000) throw new Error('Report too long (max 5000 chars)');
  const report: BugReport = {
    id: randomUUID(),
    slug: input.slug,
    email: input.email,
    message,
    page: input.page ? input.page.slice(0, 500) : undefined,
    userAgent: input.userAgent ? input.userAgent.slice(0, 500) : undefined,
    createdAt: new Date().toISOString(),
    status: 'open',
  };
  const list = await readBugs();
  list.push(report);
  // Keep the most recent MAX_BUGS so the file stays bounded.
  await writeBugs(list.slice(-MAX_BUGS));
  return report;
}

export async function setBugStatus(id: string, status: BugStatus): Promise<void> {
  const list = await readBugs();
  const r = list.find((x) => x.id === id);
  if (!r) return;
  r.status = status;
  await writeBugs(list);
}

export async function deleteBugReport(id: string): Promise<void> {
  const list = await readBugs();
  const filtered = list.filter((x) => x.id !== id);
  if (filtered.length !== list.length) await writeBugs(filtered);
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
