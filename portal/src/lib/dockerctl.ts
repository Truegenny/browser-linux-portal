// Workspace lifecycle wrappers around the Docker socket.
//
// Naming convention:
//   container:  ws-<user>
//   volume:     ws-<user>-home
//   network:    portal-net  (shared with caddy + portal)
//
// Identity comes from Caddy's X-Auth-User header. The container is the
// authoritative source of state — we store metadata in container labels
// and avoid a database in v0.

import Docker from 'dockerode';
import { config, parseMemory } from './config.js';

const docker = new Docker(); // /var/run/docker.sock

const LABEL_USER = 'ws.user';
const LABEL_CREATED = 'ws.created_at';
const LABEL_LAST_SEEN = 'ws.last_seen_at';

export interface WorkspaceInfo {
  user: string;
  containerName: string;
  volumeName: string;
  status: 'running' | 'stopped' | 'absent';
  createdAt?: string;
  lastSeenAt?: string;
  containerId?: string;
  image?: string;
}

function isValidUser(user: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,30}$/.test(user);
}

function names(user: string) {
  if (!isValidUser(user)) throw new Error(`Invalid username: ${user}`);
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
  };
}

export async function ensureWorkspace(user: string): Promise<WorkspaceInfo> {
  const { container: cName, volume: vName } = names(user);
  await ensureVolume(vName, user);

  const existing = await inspectContainerSafe(cName);
  if (existing && existing.State.Running) {
    return getWorkspace(user);
  }
  if (existing) {
    await docker.getContainer(cName).start();
    return getWorkspace(user);
  }

  // Create container fresh.
  const memBytes = parseMemory(config.workspaceMemory);
  const nanoCpus = Math.floor(Number(config.workspaceCpus) * 1e9);
  const nowIso = new Date().toISOString();

  await docker.createContainer({
    name: cName,
    Image: config.workspaceImage,
    Hostname: cName,
    Labels: {
      [LABEL_USER]: user,
      [LABEL_CREATED]: nowIso,
      [LABEL_LAST_SEEN]: nowIso,
    },
    HostConfig: {
      RestartPolicy: { Name: 'no' },
      NetworkMode: config.workspaceNetwork,
      Binds: [`${vName}:/home/node`],
      Memory: memBytes,
      MemorySwap: memBytes,
      NanoCpus: nanoCpus,
      PidsLimit: 512,
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,size=256m', '/run': 'rw,size=64m' },
      CapDrop: ['SYS_ADMIN', 'NET_ADMIN', 'SYS_MODULE', 'SYS_RAWIO'],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [config.workspaceNetwork]: { Aliases: [cName] },
      },
    },
    ExposedPorts: { '7681/tcp': {} },
  });

  await docker.getContainer(cName).start();
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
    return {
      user,
      containerName: c.Names[0]?.replace(/^\//, '') ?? `ws-${user}`,
      volumeName: `ws-${user}-home`,
      status: c.State === 'running' ? 'running' : 'stopped',
      createdAt: c.Labels[LABEL_CREATED],
      lastSeenAt: c.Labels[LABEL_LAST_SEEN],
      containerId: c.Id,
      image: c.Image,
    };
  });
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
