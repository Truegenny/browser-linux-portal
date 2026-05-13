// User management for HTTP basic auth.
//
// Reads/writes the same files scripts/add-user.sh manages:
//   /caddy/users.users   — every user, one line: "<username> <bcrypt-hash>"
//   /caddy/admins.users  — admin subset, same format
//
// Caddy bind-mounts these read-only at /etc/caddy/users.users; the portal
// bind-mounts the parent directory at /caddy:rw so it can edit. After any
// write, we ask Caddy (via Docker exec) to reload the config so the new
// state is live without a restart.
//
// All of this disappears in v1.5 when oauth2-proxy + Entra ID takes over.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import Docker from 'dockerode';

const CADDY_DIR = '/caddy';
const USERS_FILE = path.join(CADDY_DIR, 'users.users');
const ADMINS_FILE = path.join(CADDY_DIR, 'admins.users');

const docker = new Docker();

export interface UserRecord {
  username: string;
  hash: string;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name);
}

async function readFile(file: string): Promise<UserRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const records: UserRecord[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const username = line.slice(0, sp).trim();
    const hash = line.slice(sp + 1).trim();
    if (!username || !hash) continue;
    records.push({ username, hash });
  }
  return records;
}

async function writeFile(file: string, records: UserRecord[]): Promise<void> {
  const header =
    file.endsWith('admins.users')
      ? '# Admin subset. Managed by the portal /admin/users UI and scripts/add-user.sh.\n'
      : '# All users. Managed by the portal /admin/users UI and scripts/add-user.sh.\n';
  const body = records
    .slice()
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((r) => `${r.username} ${r.hash}`)
    .join('\n');
  await fs.writeFile(file, header + body + '\n', 'utf8');
}

export async function listUsers(): Promise<{
  username: string;
  isAdmin: boolean;
}[]> {
  const [users, admins] = await Promise.all([
    readFile(USERS_FILE),
    readFile(ADMINS_FILE),
  ]);
  const adminSet = new Set(admins.map((a) => a.username));
  return users
    .map((u) => ({ username: u.username, isAdmin: adminSet.has(u.username) }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

export async function isAdminFromFile(username: string): Promise<boolean> {
  const admins = await readFile(ADMINS_FILE);
  return admins.some((a) => a.username === username);
}

export async function addOrUpdateUser(
  username: string,
  password: string,
  isAdmin: boolean,
): Promise<void> {
  if (!isValidUsername(username)) throw new Error('Invalid username');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  // Cost 14 matches what scripts/add-user.sh produces via the Caddy CLI
  // and is the current industry recommendation. ~1s per hash on a B-series
  // VM — fine for a rare admin action.
  const hash = await bcrypt.hash(password, 14);

  const [users, admins] = await Promise.all([
    readFile(USERS_FILE),
    readFile(ADMINS_FILE),
  ]);

  const upsert = (list: UserRecord[]): UserRecord[] => {
    const filtered = list.filter((r) => r.username !== username);
    filtered.push({ username, hash });
    return filtered;
  };

  await writeFile(USERS_FILE, upsert(users));
  if (isAdmin) {
    await writeFile(ADMINS_FILE, upsert(admins));
  } else {
    await writeFile(ADMINS_FILE, admins.filter((a) => a.username !== username));
  }

  await reloadCaddy();
}

export async function setAdmin(username: string, isAdmin: boolean): Promise<void> {
  if (!isValidUsername(username)) throw new Error('Invalid username');
  const [users, admins] = await Promise.all([
    readFile(USERS_FILE),
    readFile(ADMINS_FILE),
  ]);
  const userRec = users.find((u) => u.username === username);
  if (!userRec) throw new Error(`No user named ${username}`);
  if (isAdmin) {
    if (admins.some((a) => a.username === username)) return; // already admin
    admins.push(userRec); // same hash
    await writeFile(ADMINS_FILE, admins);
  } else {
    await writeFile(ADMINS_FILE, admins.filter((a) => a.username !== username));
  }
  await reloadCaddy();
}

export async function deleteUser(username: string): Promise<void> {
  if (!isValidUsername(username)) throw new Error('Invalid username');
  const [users, admins] = await Promise.all([
    readFile(USERS_FILE),
    readFile(ADMINS_FILE),
  ]);
  await writeFile(USERS_FILE, users.filter((u) => u.username !== username));
  await writeFile(ADMINS_FILE, admins.filter((a) => a.username !== username));
  await reloadCaddy();
}

// ---------------------------------------------------------------------------
// Caddy reload via Docker exec
// ---------------------------------------------------------------------------
async function reloadCaddy(): Promise<void> {
  const container = docker.getContainer('caddy');
  const exec = await container.exec({
    Cmd: ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
    stream.resume(); // drain so the 'end' event fires
  });
  const info = await exec.inspect();
  if (info.ExitCode != null && info.ExitCode !== 0) {
    throw new Error(`caddy reload exited with code ${info.ExitCode}`);
  }
}
