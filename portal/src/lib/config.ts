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
  workspaceImage: env('WORKSPACE_IMAGE', 'browser-linux-workspace:latest'),
  workspaceNetwork: env('WORKSPACE_NETWORK', 'workspace-net'),
  // Per-tier memory caps. Terminal-tier users don't run KasmVNC/XFCE/Firefox,
  // so 2g is plenty; desktop users need ~1g extra headroom.
  workspaceMemoryTerminal: env('WORKSPACE_MEMORY_TERMINAL', '2g'),
  workspaceMemoryDesktop: env('WORKSPACE_MEMORY_DESKTOP', '3g'),
  workspaceCpus: env('WORKSPACE_CPUS', '1.5'),
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
