// Read the running portal's version straight from package.json so the
// number shown in the UI stays in sync with whatever Docker built.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/lib/version.js → ../../package.json   (portal root)
// In the Docker image, dist/ lives at /app/dist/ so this resolves to /app/package.json.
const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');

let version = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (pkg.version) version = pkg.version;
} catch {
  // Leave as 'unknown' — failing to read package.json shouldn't crash the portal.
}

export const VERSION = version;
