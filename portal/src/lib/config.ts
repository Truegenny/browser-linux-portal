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
  workspaceMemory: env('WORKSPACE_MEMORY', '2g'),
  workspaceCpus: env('WORKSPACE_CPUS', '1.5'),
  workspaceIdleHours: envNum('WORKSPACE_IDLE_HOURS', 2),
  adminUsers: env('ADMIN_USERS', 'admin')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
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
