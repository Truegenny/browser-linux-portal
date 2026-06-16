// Host health metrics for the admin dashboard.
//
// The portal runs in a container but can still see the *host* because the
// relevant procfs files aren't namespaced: /proc/stat, /proc/meminfo and
// /proc/uptime report host-wide values even from inside a container. Disk is
// read with statfs() against the bind-mounted /caddy dir, which lives on the
// host filesystem, so it reports the host disk. Static facts (hostname, OS,
// kernel, CPU count, container counts) come from the Docker daemon via
// docker.info(). No extra mounts required — only the Docker socket the portal
// already has.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import Docker from 'dockerode';

const docker = new Docker();

export interface HostStats {
  uptimeSec: number | null;
  loadAvg: [number, number, number];
  cpuCount: number;
  cpuPct: number | null;          // sampled over a short window
  memTotal: number;
  memUsed: number;
  memAvailable: number;
  diskTotal: number;
  diskUsed: number;
  diskAvail: number;
  diskPath: string;
  hostname: string;
  os: string;
  kernel: string;
  dockerVersion: string;
  containersRunning: number;
  containersTotal: number;
  images: number;
}

async function readCpuTotals(): Promise<{ idle: number; total: number } | null> {
  try {
    const data = await fs.readFile('/proc/stat', 'utf8');
    const line = data.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    // cpu  user nice system idle iowait irq softirq steal guest guest_nice
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (n[3] ?? 0) + (n[4] ?? 0); // idle + iowait
    const total = n.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    return { idle, total };
  } catch {
    return null;
  }
}

// Busy % across all cores, sampled over `ms` (two /proc/stat reads).
async function sampleCpuPct(ms = 300): Promise<number | null> {
  const a = await readCpuTotals();
  if (!a) return null;
  await new Promise((r) => setTimeout(r, ms));
  const b = await readCpuTotals();
  if (!b) return null;
  const dt = b.total - a.total;
  const di = b.idle - a.idle;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - di / dt) * 100));
}

async function readMem(): Promise<{ total: number; available: number; used: number }> {
  try {
    const data = await fs.readFile('/proc/meminfo', 'utf8');
    const map: Record<string, number> = {};
    for (const line of data.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
      if (m && m[1]) map[m[1]] = Number(m[2]) * 1024;
    }
    const total = map.MemTotal ?? 0;
    // MemAvailable is the kernel's own estimate of allocatable memory; prefer
    // it over MemFree (which ignores reclaimable cache).
    const available = map.MemAvailable ?? map.MemFree ?? 0;
    return { total, available, used: Math.max(0, total - available) };
  } catch {
    // Fall back to the os module (also host-wide on Linux).
    const total = os.totalmem();
    const available = os.freemem();
    return { total, available, used: Math.max(0, total - available) };
  }
}

async function readUptime(): Promise<number | null> {
  try {
    const data = await fs.readFile('/proc/uptime', 'utf8');
    const v = parseFloat(data.split(' ')[0] ?? '');
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function readDisk(): Promise<{
  total: number;
  used: number;
  avail: number;
  path: string;
}> {
  // /caddy is a bind mount of the host project dir, so statfs reports the
  // host filesystem backing it (typically the same disk as /var/lib/docker).
  const candidates = ['/caddy', '/var/log/caddy', '/'];
  for (const path of candidates) {
    try {
      const s = await fs.statfs(path);
      const bsize = Number(s.bsize);
      const total = Number(s.blocks) * bsize;
      const free = Number(s.bfree) * bsize;       // free incl. root-reserved
      const avail = Number(s.bavail) * bsize;      // free to non-root
      if (total > 0) {
        return { total, used: Math.max(0, total - free), avail, path };
      }
    } catch {
      /* try next candidate */
    }
  }
  return { total: 0, used: 0, avail: 0, path: '(unavailable)' };
}

export async function getHostStats(): Promise<HostStats> {
  // Docker daemon info (host facts + container counts). Tolerate failure.
  let info: any = {};
  try {
    info = await docker.info();
  } catch {
    info = {};
  }

  const [cpuPct, mem, uptimeSec, disk] = await Promise.all([
    sampleCpuPct(),
    readMem(),
    readUptime(),
    readDisk(),
  ]);

  const load = os.loadavg();

  return {
    uptimeSec,
    loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpuCount: info.NCPU ?? os.cpus().length ?? 0,
    cpuPct,
    memTotal: mem.total || info.MemTotal || 0,
    memUsed: mem.used,
    memAvailable: mem.available,
    diskTotal: disk.total,
    diskUsed: disk.used,
    diskAvail: disk.avail,
    diskPath: disk.path,
    hostname: info.Name ?? os.hostname(),
    os: info.OperatingSystem ?? `${os.type()} ${os.release()}`,
    kernel: info.KernelVersion ?? os.release(),
    dockerVersion: info.ServerVersion ?? '—',
    containersRunning: info.ContainersRunning ?? 0,
    containersTotal: info.Containers ?? 0,
    images: info.Images ?? 0,
  };
}
