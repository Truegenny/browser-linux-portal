// Workspace lifecycle wrappers around the Docker socket.
//
// Naming convention:
//   container:  ws-<user>
//   volume:     ws-<user>-home
//   network:    workspace-net  (shared with caddy only; portal is NOT on it)
//
// Identity comes from Caddy's X-Auth-User header. The container is the
// authoritative source of state — we store metadata in container labels
// and avoid a database in v0.

import Docker from 'dockerode';
import { posix as posixPath } from 'node:path';
import { config, parseMemory } from './config.js';
import { USERNAME_RE, getBanner, type WorkspaceTier } from './users.js';

const docker = new Docker(); // /var/run/docker.sock

const LABEL_USER = 'ws.user';
const LABEL_CREATED = 'ws.created_at';
const LABEL_LAST_SEEN = 'ws.last_seen_at';
const LABEL_TIER = 'ws.tier';
const ENV_ENABLE_DESKTOP = 'ENABLE_DESKTOP';

export interface WorkspaceInfo {
  user: string;
  containerName: string;
  volumeName: string;
  status: 'running' | 'stopped' | 'absent';
  createdAt?: string;
  lastSeenAt?: string;
  containerId?: string;
  image?: string;
  // The tier the container was last (re)created with. Reflects what's
  // actually running, not necessarily what the admin's current preference
  // is — that comes from users.getUserTier().
  containerTier?: WorkspaceTier;
}

function names(user: string) {
  // Single source of truth lives in lib/users.ts so the slug regex stays
  // in sync across the portal, Caddyfile (header_regexp), and any future
  // consumer.
  if (!USERNAME_RE.test(user)) throw new Error(`Invalid username: ${user}`);
  return {
    container: `ws-${user}`,
    volume: `ws-${user}-home`,
  };
}

async function inspectContainerSafe(name: string) {
  try {
    return await docker.getContainer(name).inspect();
  } catch (e: any) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

async function ensureVolume(volumeName: string, user: string) {
  try {
    await docker.getVolume(volumeName).inspect();
  } catch (e: any) {
    if (e.statusCode === 404) {
      await docker.createVolume({
        Name: volumeName,
        Labels: { [LABEL_USER]: user },
      });
    } else {
      throw e;
    }
  }
}

export async function getWorkspace(user: string): Promise<WorkspaceInfo> {
  const { container: cName, volume: vName } = names(user);
  const ins = await inspectContainerSafe(cName);
  if (!ins) {
    return {
      user,
      containerName: cName,
      volumeName: vName,
      status: 'absent',
    };
  }
  return {
    user,
    containerName: cName,
    volumeName: vName,
    status: ins.State.Running ? 'running' : 'stopped',
    containerId: ins.Id,
    image: ins.Config.Image,
    createdAt: ins.Config.Labels?.[LABEL_CREATED] ?? ins.Created,
    lastSeenAt: ins.Config.Labels?.[LABEL_LAST_SEEN],
    containerTier: readContainerTier(ins),
  };
}

function tierEnabledDesktop(tier: WorkspaceTier): string {
  return tier === 'desktop' ? '1' : '0';
}

function readContainerTier(ins: Docker.ContainerInspectInfo): WorkspaceTier {
  // Prefer the label (set at create time), fall back to the env var.
  const labelTier = ins.Config.Labels?.[LABEL_TIER];
  if (labelTier === 'desktop' || labelTier === 'terminal') return labelTier;
  const env = ins.Config.Env ?? [];
  const found = env.find((e) => e.startsWith(`${ENV_ENABLE_DESKTOP}=`));
  return found?.endsWith('=1') ? 'desktop' : 'terminal';
}

export async function ensureWorkspace(
  user: string,
  opts: { tier: WorkspaceTier },
): Promise<WorkspaceInfo> {
  const { container: cName, volume: vName } = names(user);
  await ensureVolume(vName, user);

  const existing = await inspectContainerSafe(cName);
  if (existing) {
    // Tier mismatch is detected on stopped containers: recreate so the new
    // tier's memory cap and ENABLE_DESKTOP env take effect. Running
    // containers are never silently restarted — the admin/user must stop
    // first, which makes a tier-change-induced reboot an explicit action.
    if (existing.State.Running) return getWorkspace(user);
    const currentTier = readContainerTier(existing);
    if (currentTier === opts.tier) {
      await docker.getContainer(cName).start();
      await pushBannerToWorkspace(user);
      return getWorkspace(user);
    }
    // Tier changed while stopped — destroy the container (keep the volume)
    // and fall through to recreation below.
    await docker.getContainer(cName).remove({ force: true });
  }

  // Create container fresh.
  const memSpec =
    opts.tier === 'desktop'
      ? config.workspaceMemoryDesktop
      : config.workspaceMemoryTerminal;
  const memBytes = parseMemory(memSpec);
  const nanoCpus = Math.floor(Number(config.workspaceCpus) * 1e9);
  const nowIso = new Date().toISOString();

  await docker.createContainer({
    name: cName,
    Image: config.workspaceImage,
    Hostname: cName,
    Env: [
      `WS_USER=${user}`,
      // filebrowser inside the container expects this prefix in the URL it
      // receives (we set it as its --baseurl); Caddy rewrites incoming
      // requests onto this exact path before proxying.
      `FB_BASEURL=/u/${user}/files`,
      // KasmVNC's subpath (set via ~/.vnc/kasmvnc.yaml in entrypoint.sh).
      // Must match the path Caddy rewrites requests to.
      `VNC_BASEURL=/u/${user}/desktop`,
      // Tier flag — entrypoint.sh skips KasmVNC + XFCE startup when 0.
      `${ENV_ENABLE_DESKTOP}=${tierEnabledDesktop(opts.tier)}`,
    ],
    Labels: {
      [LABEL_USER]: user,
      [LABEL_CREATED]: nowIso,
      [LABEL_LAST_SEEN]: nowIso,
      [LABEL_TIER]: opts.tier,
    },
    HostConfig: {
      RestartPolicy: { Name: 'no' },
      NetworkMode: config.workspaceNetwork,
      Binds: [`${vName}:/home/node`],
      Memory: memBytes,
      MemorySwap: memBytes,
      NanoCpus: nanoCpus,
      PidsLimit: 512,
      // /dev/shm. Docker defaults this to 64 MB, which is far too small for
      // Chromium: it stores renderer<->browser shared-memory IPC and rendered
      // tiles here, and a heavy page (e.g. driving a big SPA via Playwright)
      // exhausts 64 MB and the renderer SIGABRTs — surfacing as Playwright
      // "Target crashed" / "page.goto: Page crashed", then a cascade of
      // relaunches, lost auth context, and locator timeouts. 512 MB clears it.
      // NB: this is a real /dev/shm (tmpfs), so users do NOT need
      // --disable-dev-shm-usage — and shouldn't use it here, since that would
      // push shared memory onto the swapless memory cgroup and trade shm
      // crashes for OOM-kills. Chromium still needs --no-sandbox (this
      // container has no SYS_ADMIN and no-new-privileges, so its sandbox can't
      // initialize). Heavy runs may still hit the per-tier RAM cap (2g/3g);
      // those users want the desktop tier or a higher cap.
      ShmSize: parseMemory(config.workspaceShmSize),
      SecurityOpt: ['no-new-privileges:true'],
      // /tmp is deliberately NOT a tmpfs. A tmpfs is RAM-backed and counts
      // against the Memory cgroup cap, so a size-capped /tmp (we had 256m)
      // fills and ENOSPC-crashes on large `git clone`s, npm/pip caches, and
      // build temp files — and raising the cap would just trade ENOSPC for
      // an OOM-kill against the tier's RAM budget. Leaving /tmp off Tmpfs
      // puts it on the container's writable overlay (host disk), bounded by
      // host disk like the home volume, not by RAM. Still wiped on container
      // recreate. /run stays a small tmpfs (pid/lock files only).
      Tmpfs: { '/run': 'rw,size=64m' },
      // Security: drop all Linux capabilities then add back only those a
      // dev shell with sudo actually needs. Default Docker grants 14 caps;
      // we keep 7 and drop the others (NET_RAW, NET_BIND_SERVICE, MKNOD,
      // SETPCAP, SETFCAP, SYS_CHROOT, AUDIT_WRITE).
      CapDrop: ['ALL'],
      CapAdd: [
        'CHOWN',          // apt / npm chown of installed files
        'DAC_OVERRIDE',   // read files across user/group permissions
        'FOWNER',         // chmod / utime on files you don't own
        'FSETID',         // preserve setuid/setgid on chmod
        'KILL',           // kill processes you own
        'SETUID',         // sudo: switch to root
        'SETGID',         // sudo: switch group
      ],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [config.workspaceNetwork]: { Aliases: [cName] },
      },
    },
    ExposedPorts: { '7681/tcp': {}, '7682/tcp': {}, '7683/tcp': {} },
  });

  await docker.getContainer(cName).start();
  await pushBannerToWorkspace(user);
  return getWorkspace(user);
}

export async function stopWorkspace(user: string): Promise<void> {
  const { container: cName } = names(user);
  const ins = await inspectContainerSafe(cName);
  if (!ins) return;
  if (ins.State.Running) {
    await docker.getContainer(cName).stop({ t: 10 }).catch(() => {
      // Ignore if already stopped between inspect and stop.
    });
  }
}

export async function destroyWorkspace(
  user: string,
  opts: { keepVolume?: boolean } = {},
): Promise<void> {
  const { container: cName, volume: vName } = names(user);
  const ins = await inspectContainerSafe(cName);
  if (ins) {
    await docker.getContainer(cName).remove({ force: true });
  }
  if (!opts.keepVolume) {
    await docker
      .getVolume(vName)
      .remove()
      .catch((e) => {
        if (e.statusCode !== 404) throw e;
      });
  }
}

export async function touchLastSeen(user: string): Promise<void> {
  // Updating labels on a running container requires recreate, which is
  // expensive. Instead, we record last-seen on the host filesystem.
  // (Wired up later if needed for the idle reaper.)
  void user;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL_USER}`] },
  });
  return containers.map((c) => {
    const user = c.Labels[LABEL_USER] ?? 'unknown';
    const tierLabel = c.Labels[LABEL_TIER];
    const containerTier: WorkspaceTier | undefined =
      tierLabel === 'desktop' || tierLabel === 'terminal' ? tierLabel : undefined;
    return {
      user,
      containerName: c.Names[0]?.replace(/^\//, '') ?? `ws-${user}`,
      volumeName: `ws-${user}-home`,
      status: c.State === 'running' ? 'running' : 'stopped',
      createdAt: c.Labels[LABEL_CREATED],
      lastSeenAt: c.Labels[LABEL_LAST_SEEN],
      containerId: c.Id,
      image: c.Image,
      containerTier,
    };
  });
}

// ---------------------------------------------------------------------------
// Announcement banner delivery.
// ---------------------------------------------------------------------------
// The login shell in each workspace prints /run/claudelab/banner (see the
// workspace image's show-banner.sh). The workspace can't fetch the banner from
// the portal — workspace-net is isolated from portal:3000 — so the portal
// writes the file via the Docker socket: on workspace create/start, and (via
// pushBannerToRunning) whenever an admin changes the banner. All best-effort:
// banner delivery must never block or fail a workspace start.
async function writeBannerToContainer(cName: string, text: string): Promise<void> {
  // base64 so arbitrary banner text (quotes, newlines, $, backticks) can't
  // break out of the shell command. The b64 alphabet is shell-safe in quotes.
  const b64 = Buffer.from(text ?? '', 'utf8').toString('base64');
  const script =
    `mkdir -p /run/claudelab && printf %s '${b64}' | base64 -d > /run/claudelab/banner`;
  const exec = await docker.getContainer(cName).exec({
    Cmd: ['sh', '-c', script],
    User: 'root',
    AttachStdout: false,
    AttachStderr: false,
  });
  await exec.start({ Detach: true });
}

// Push a user's workspace its current banner (best-effort; swallows errors).
async function pushBannerToWorkspace(user: string): Promise<void> {
  try {
    const banner = await getBanner();
    const { container: cName } = names(user);
    await writeBannerToContainer(cName, banner?.message ?? '');
  } catch {
    /* best-effort */
  }
}

// Write the given banner text to every running workspace. Called by the
// portal's /admin/banner routes after an admin sets or clears the banner.
export async function pushBannerToRunning(text: string): Promise<void> {
  let containers: Docker.ContainerInfo[];
  try {
    // No `all: true` → running containers only (exec needs a running target).
    containers = await docker.listContainers({
      filters: { label: [`${LABEL_USER}`] },
    });
  } catch {
    return;
  }
  await Promise.all(
    containers.map(async (c) => {
      const name = c.Names[0]?.replace(/^\//, '');
      if (!name) return;
      try {
        await writeBannerToContainer(name, text);
      } catch {
        /* one bad container shouldn't abort the rest */
      }
    }),
  );
}

export interface ListeningPort {
  user: string;
  port: number;
  address: string;       // 0.0.0.0, *, ::, 127.0.0.1, ::1
  reachable: boolean;    // true if Caddy can proxy (i.e., bound on a wildcard)
}

// Exec `ss -tln` inside the user's workspace and parse the listening sockets.
// Loopback-only sockets (127.0.0.1 / ::1) appear too but are flagged as
// unreachable from the proxy — that surfaces a common bug ("works in
// localhost but not from the browser").
export async function listListeningPorts(user: string): Promise<ListeningPort[]> {
  const { container: cName } = names(user);
  const ins = await inspectContainerSafe(cName);
  if (!ins || !ins.State.Running) return [];

  let raw: Buffer;
  try {
    raw = await execAndCapture(cName, ['ss', '-tln']);
  } catch {
    return [];
  }
  const text = demuxDockerStream(raw);
  return parseSsListenLines(text, user);
}

async function execAndCapture(
  containerName: string,
  cmd: string[],
): Promise<Buffer> {
  const exec = await docker.getContainer(containerName).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

// Docker exec with no Tty multiplexes stdout/stderr into 8-byte-header chunks.
// Each chunk: [stream_id (1B), 0, 0, 0, length (4B BE), payload (length B)].
// stream_id: 1 = stdout, 2 = stderr.
function demuxDockerStream(buf: Buffer): string {
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    const end = Math.min(i + 8 + len, buf.length);
    out += buf.subarray(i + 8, end).toString('utf8');
    i = end;
  }
  return out;
}

// Same as demuxDockerStream but returns only stdout chunks as a Buffer.
// Important for binary file reads where mixing stderr text would corrupt
// the payload.
function demuxStdoutBuffer(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const streamId = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const end = Math.min(i + 8 + len, buf.length);
    if (streamId === 1) parts.push(buf.subarray(i + 8, end));
    i = end;
  }
  return Buffer.concat(parts);
}

function parseSsListenLines(text: string, user: string): ListeningPort[] {
  const result: ListeningPort[] = [];
  for (const line of text.split('\n')) {
    // Match: LISTEN <recv-q> <send-q> <local-addr:port> <peer-addr:port> ...
    const m = line.trim().match(/^LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+/);
    if (!m) continue;
    const local = m[1];
    if (!local) continue;
    // local can be "0.0.0.0:47291", "[::]:7681", "127.0.0.1:8000", "*:1234"
    const sp = local.lastIndexOf(':');
    if (sp < 0) continue;
    const address = local.slice(0, sp).replace(/^\[|\]$/g, '');
    const port = Number(local.slice(sp + 1));
    if (!Number.isFinite(port) || port <= 0) continue;
    const wildcard = address === '0.0.0.0' || address === '*' || address === '::';
    result.push({ user, port, address, reachable: wildcard });
  }
  // De-dupe (ss prints both v4 and v6 entries for dual-stack listeners).
  const seen = new Set<string>();
  return result.filter((p) => {
    const k = `${p.port}:${p.reachable ? 'r' : 'l'}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.port - b.port);
}

// Snapshot of the workspace container's stdout+stderr. Works on stopped
// containers too (the daemon retains logs until the container is removed).
// Returns the demuxed text — the Docker daemon multiplexes stdout/stderr
// into 8-byte-framed chunks because we don't allocate a TTY.
export async function getContainerLogs(
  user: string,
  opts: { tailLines?: number } = {},
): Promise<string> {
  const { container: cName } = names(user);
  const ins = await inspectContainerSafe(cName);
  if (!ins) return '';
  const buf: Buffer = await new Promise((resolve, reject) => {
    docker.getContainer(cName).logs(
      {
        stdout: true,
        stderr: true,
        tail: opts.tailLines ?? 500,
        timestamps: true,
        follow: false,
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(Buffer.isBuffer(data) ? data : Buffer.from(data ?? ''));
      },
    );
  });
  return demuxDockerStream(buf);
}

// ---------------------------------------------------------------------------
// File browser via Docker exec.
// ---------------------------------------------------------------------------
// Cross-user filebrowser doesn't compose with filebrowser's baked-in
// --baseurl, so for admin file viewing we use the Docker socket directly:
// `docker exec ls` for directory listings, `docker exec cat` for file
// contents. Read-only, sandboxed to /home/node so admins can't fish around
// the rest of the container's filesystem.

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

// Constrain to the user's home dir. node:posix-paths to normalize, then a
// startsWith check after — defends against ".." traversal in the input.
function sandboxPath(input: string, root: string = '/home/node'): string {
  const normalized = posixPath.normalize(input || root);
  if (normalized !== root && !normalized.startsWith(root + '/')) {
    throw new Error(`Path must be under ${root}`);
  }
  return normalized;
}

export async function listContainerDir(
  user: string,
  dirPath: string,
): Promise<DirEntry[]> {
  const safePath = sandboxPath(dirPath);
  const { container: cName } = names(user);
  const ins = await inspectContainerSafe(cName);
  if (!ins || !ins.State.Running) return [];

  // ls flags chosen for parseability: -la for hidden+long, --time-style
  // for predictable timestamps, -- to terminate flag parsing so paths
  // can never be interpreted as options.
  const raw = await execAndCapture(cName, [
    'ls',
    '-la',
    '--time-style=+%Y-%m-%d %H:%M',
    '--',
    safePath,
  ]);
  const text = demuxDockerStream(raw);
  const entries: DirEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('total ')) continue;
    // perms links owner group size YYYY-MM-DD HH:MM name
    const m = line.match(
      /^([d-])[rwxsStT-]{9}[\.\+]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+)$/,
    );
    if (!m) continue;
    const dirChar = m[1];
    const sizeStr = m[2];
    const mtime = m[3];
    const name = m[4];
    if (!dirChar || !sizeStr || !mtime || !name) continue;
    if (name === '.' || name === '..') continue;
    entries.push({
      name,
      isDir: dirChar === 'd',
      size: parseInt(sizeStr, 10),
      mtime,
    });
  }
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Read a file's bytes via `cat`. Caller decides what to do with the buffer
// (download stream, text preview, etc.). Hard-caps the size to avoid
// loading huge files into memory.
export async function readContainerFile(
  user: string,
  filePath: string,
  maxBytes: number = 25 * 1024 * 1024,
): Promise<{ data: Buffer; truncated: boolean }> {
  const safePath = sandboxPath(filePath);
  const { container: cName } = names(user);
  const ins = await inspectContainerSafe(cName);
  if (!ins || !ins.State.Running) {
    throw new Error('container not running');
  }
  // Use `head -c <N+1>` so we can detect truncation without slurping the
  // whole file. +1 because if we read exactly maxBytes we don't know if
  // there's more.
  const raw = await execAndCapture(cName, [
    'head',
    '-c',
    String(maxBytes + 1),
    '--',
    safePath,
  ]);
  const data = demuxStdoutBuffer(raw);
  if (data.length > maxBytes) {
    return { data: data.subarray(0, maxBytes), truncated: true };
  }
  return { data, truncated: false };
}

export async function workspaceStats(
  user: string,
): Promise<{ cpuPct: number; memBytes: number; memLimit: number } | null> {
  const { container: cName } = names(user);
  const ins = await inspectContainerSafe(cName);
  if (!ins || !ins.State.Running) return null;
  const stats: any = await new Promise((resolve, reject) => {
    docker.getContainer(cName).stats({ stream: false }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta =
    stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = stats.cpu_stats.online_cpus ?? 1;
  const cpuPct =
    sysDelta > 0 ? (cpuDelta / sysDelta) * cpuCount * 100 : 0;

  return {
    cpuPct,
    memBytes: stats.memory_stats.usage ?? 0,
    memLimit: stats.memory_stats.limit ?? 0,
  };
}
