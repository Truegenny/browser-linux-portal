// Centralized env loading. Throws on missing required values.

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} is not a number: ${v}`);
  return n;
}

export const config = {
  port: envNum('PORT', 3000),
  domain: env('DOMAIN', 'localhost'),
  workspaceImage: env('WORKSPACE_IMAGE', 'claudelab-workspace:latest'),
  // Separate image for the power tier (Ubuntu 24.04 + KDE Plasma + the full
  // Playwright suite). Built by its own one-shot builder in compose.
  workspaceImagePower: env('WORKSPACE_IMAGE_POWER', 'claudelab-workspace-power:latest'),
  workspaceNetwork: env('WORKSPACE_NETWORK', 'workspace-net'),
  // Per-tier memory caps. Terminal-tier users don't run KasmVNC/XFCE/Firefox,
  // so 2g is plenty; desktop users need ~1g extra headroom; power users run
  // KDE + multiple headed browsers under Playwright/cowork, so they get more.
  workspaceMemoryTerminal: env('WORKSPACE_MEMORY_TERMINAL', '2g'),
  workspaceMemoryDesktop: env('WORKSPACE_MEMORY_DESKTOP', '3g'),
  workspaceMemoryPower: env('WORKSPACE_MEMORY_POWER', '8g'),
  // Size of /dev/shm in each workspace. Docker's default is a tiny 64 MB,
  // which makes Chromium/Playwright renderers SIGABRT ("Target crashed" /
  // "Page crashed") on heavy pages because Chromium backs renderer IPC and
  // tile buffers in shared memory. 512 MB clears that ceiling. Kept well
  // under the per-tier RAM cap because /dev/shm is tmpfs and its used pages
  // count against the same memory cgroup — so don't size it near the cap.
  workspaceShmSize: env('WORKSPACE_SHM_SIZE', '512m'),
  // Power tier runs several headed Chromium contexts at once, so it gets a
  // larger /dev/shm and more CPU than the standard tiers. Both fall back to
  // the standard knob's value when unset, so the power tier still works even
  // if only the standard knobs are configured.
  workspaceShmSizePower: env('WORKSPACE_SHM_SIZE_POWER', '2g'),
  workspaceCpus: env('WORKSPACE_CPUS', '1.5'),
  workspaceCpusPower: env('WORKSPACE_CPUS_POWER', '4'),
  workspaceIdleHours: envNum('WORKSPACE_IDLE_HOURS', 2),
  // Bootstrap admin allowlist by email. The canonical signal is the Entra
  // groups claim — see adminGroupOid — but this env is the fallback for
  // first sign-in before the group is wired up.
  adminUsers: env('ADMIN_USERS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Entra group object ID whose members get admin. Empty string disables
  // group-based admin entirely; users would then need ADMIN_USERS entries.
  adminGroupOid: env('ADMIN_GROUP_OID', '').trim(),
} as const;

// Convert "2g" / "512m" to bytes for dockerode.
export function parseMemory(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)b?$/);
  if (!m) throw new Error(`Bad memory string: ${s}`);
  const n = Number(m[1]);
  const mult: Record<string, number> = {
    '': 1,
    k: 1024,
    K: 1024,
    m: 1024 ** 2,
    M: 1024 ** 2,
    g: 1024 ** 3,
    G: 1024 ** 3,
  };
  return Math.floor(n * (mult[m[2] ?? ''] ?? 1));
}
