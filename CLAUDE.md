# Browser Linux Portal — project context

A self-hosted dev workspace platform. One Linux VM, Docker, a per-user Debian
container with `claude` (Claude Code CLI), `ttyd` (browser terminal), and
`filebrowser` (drag-and-drop file manager). Caddy fronts everything with
basic auth (Entra OIDC planned for v1.5). Marketed as a small alternative to
Coder / Codespaces / WebVM.

Repo: https://github.com/Truegenny/browser-linux-portal (private — verify before pushing anything sensitive)

If you're a fresh Claude session: **read the README first, then this file.**
The README covers user-facing setup; this file covers architecture decisions,
conventions, and gotchas that aren't obvious from the code.

---

## Current state

- **Version:** see `portal/package.json` (`v0.7.3` at time of writing)
- **Deployed:** Ubuntu 24.04 VM on Azure (`ClaudeDocker`, public IP 20.125.57.59), running directly as Docker containers (not Portainer). Repo cloned at `~/browser-linux-portal`.
- **Stack name:** `browser-linux-portal` (compose project)
- **Public port:** 8080 (HTTP, no DNS yet — IP-only access). Production setup with TLS is documented in `docs/DEPLOY.md` but not yet deployed.

## Architecture

```
  Browser
    │  HTTPS or HTTP
    ▼
┌─────────┐   basic_auth (today)   →   oauth2-proxy + Entra ID (v1.5 plan)
│  Caddy  │   sets X-Auth-User from auth identity
└────┬────┘
     │
     ├──→ /                   public marketing page              (portal)
     ├──→ /app, /admin, /api  authed dashboard / admin / API     (portal)
     ├──→ /logout             cache-poison page (no auth)        (Caddy inline)
     │
     ├──→ /u/<slug>/desktop/<…> →  ws-<auth_user>:7683  (KasmVNC + XFCE4 GUI)
     ├──→ /u/<slug>/files/<…>   →  ws-<auth_user>:7682  (filebrowser)
     ├──→ /u/<slug>/p/<port>/<…> →  ws-<auth_user>:<port>  (user webapp)
     └──→ /u/<slug>/<…>         →  ws-<auth_user>:7681  (ttyd terminal)
```

Three running services in compose: `caddy`, `portal`, and a one-shot
`workspace-image-builder` (builds the per-user image, exits 0). Workspace
containers (`ws-<user>`) are spawned dynamically by the portal via the
Docker socket as users sign in.

## Critical conventions (don't break these)

1. **Route by auth identity, not URL slot.** Every `/u/<slot>/...` route
   ignores `<slot>` and proxies to `ws-<auth_user>:...`. This is more
   secure than comparing slot to auth (no way to even attempt cross-user
   access) and we proved the alternative — CEL expression matchers and
   placeholder substitution in `path_regexp` patterns — is fragile.

2. **Workspace ports must bind `0.0.0.0`** to be reachable through the
   proxy. `127.0.0.1` works inside the container but is unreachable from
   Caddy on `portal-net`. The dashboard ports sidebar flags loopback
   binds explicitly.

3. **Auth contract is `X-Auth-User` header.** Caddy sets it after
   basic_auth. Portal trusts it because the portal is never published —
   only Caddy is. Same header set by oauth2-proxy in v1.5; portal code
   doesn't change.

4. **Username regex everywhere:** `^[a-z0-9][a-z0-9_-]{0,30}$`. Defined
   in `portal/src/lib/users.ts` (`USERNAME_RE`). Don't relax; it's
   load-bearing for safe interpolation into URLs, container names,
   volume names, and shell args.

5. **Workspace identity = auth identity.** Container `ws-<user>`,
   volume `ws-<user>-home` mounted at `/home/node`. The in-container
   user is the upstream `node` user (uid 1000) from `node:20-bookworm-slim`
   — we do *not* `useradd` (the slim image strips `passwd` package).

## Top-level layout

```
caddy/                 — Caddyfile + *.users.example templates
                         (real users.users + admins.users are GITIGNORED;
                          ./scripts/add-user.sh creates them on each VM)
portal/                — Fastify + TS app
  src/
    server.ts          — routes
    lib/
      auth.ts          — reads X-Auth-User; admin status from admins.users
      config.ts        — env loader
      dockerctl.ts     — workspace lifecycle, port-listing via `ss -tln`
      html.ts          — layout helper (header/footer + version)
      users.ts         — file-based user CRUD + bcryptjs + caddy reload
      version.ts       — reads package.json at runtime
    views/             — server-rendered HTML (template literals)
  public/styles.css    — single dark-themed stylesheet
workspace-image/       — Dockerfile + entrypoint for ws-* containers
scripts/               — add-user.sh, build-workspace-image.sh, idle-stop.sh
docs/DEPLOY.md         — Ubuntu/Azure deploy runbook (THE authoritative one)
```

## Key knobs (`.env` → compose env)

- `SITE_ADDRESS` — Caddy site label. `:80` (default) for IP/HTTP-only,
  `box.example.com` for prod with auto-Let's Encrypt.
- `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` — host port mappings
- `WORKSPACE_MEMORY` / `WORKSPACE_CPUS` / `WORKSPACE_IDLE_HOURS` — per-container limits
- `ADMIN_USERS` — bootstrap admin allowlist (file `admins.users` is the runtime source of truth)

## Common commands (inside the project root)

```bash
# Add or reset a basicauth user (interactive password prompt)
./scripts/add-user.sh <name> [--admin]

# Rebuild workspace image (after Dockerfile changes); ~5-10 min
docker compose build --no-cache workspace-image

# Apply Caddyfile changes without restarting Caddy
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile

# Force-recreate the portal after code changes
docker compose up -d --build portal

# Drop a user's workspace container (volume preserved by name)
docker rm -f ws-<user>

# Backup all workspace volumes
for vol in $(docker volume ls -q --filter name='^ws-.*-home$'); do
  docker run --rm -v "$vol:/data:ro" -v "$PWD/backups:/out" alpine \
    tar czf "/out/${vol}-$(date -u +%F).tgz" -C /data .
done
```

## Bugs we hit and how we fixed them (so future you doesn't repeat them)

### Build-time

| Symptom | Cause | Fix |
|---|---|---|
| `exit 127` on `useradd -u 1000 dev` | `passwd` package stripped from `node:20-bookworm-slim` | Reuse the upstream `node` user (uid 1000); don't `useradd` |
| NodeSource `setup_20.x | bash -` failed silently | Bare `debian:12-slim` lacks `lsb-release` and other helpers | Use `node:20-bookworm-slim` directly; drop NodeSource |
| `ttyd.x86_64` hardcoded | wrong arch on arm64 hosts | Use `$TARGETARCH` to pick `ttyd.x86_64` / `ttyd.aarch64` |
| `filebrowser users add` rejected | password validator requires ≥12 chars | Use `noauth-unused-placeholder-xxx` (32 chars; never used since auth is disabled) |
| Compose pulled image from Docker Hub instead of building | Compose's default `pull_policy` for services with `image:` is `missing` | Add `pull_policy: build` on locally-built services (`portal`, `workspace-image`) |

### Runtime

| Symptom | Cause | Fix |
|---|---|---|
| Caddy bind-mount: "not a directory" | A previous failed deploy auto-created a *directory* at the file mount target | Bind-mount whole `caddy/` dir at `/etc/caddy`, not individual files |
| Caddy 308 redirect to HTTPS on `localhost:8080` | Site label `localhost` triggers Caddy's auto-HTTPS | Use `:80` site label (or env `SITE_ADDRESS`) for plain HTTP |
| `/u/<user>/` 403 with "your workspace is at /u/<auth>/" | `path_regexp` patterns are compiled at config-load, so `{http.auth.user.id}` placeholder didn't substitute | Don't compare slot to auth; route purely by auth identity |
| `expression` matcher: "token recognition error at: '`ph('" | Backticks around placeholders ended up in the compiled CEL string | Don't quote placeholders in `expression`; Caddy auto-converts `{...}` → `ph(req, "...")` |
| Form POST returns 415 from Fastify | Fastify ships JSON-only body parser by default | `await app.register(fastifyFormbody)` before routes |
| Filebrowser asks for login despite `--auth.method=noauth` | `users add` failed silently in entrypoint (stderr → /dev/null + `\|\| true`) | Bake the DB at image build time so failures break the build, not runtime |

### TypeScript / portal source

| Symptom | Cause | Fix |
|---|---|---|
| `error TS1005: ':' expected` at admin.ts:93 | `'You can\\'t demote yourself.'` — `\\` is a literal backslash, then `'` closes the string | Use `\'` (one backslash) inside single-quoted strings, or rewrite without apostrophes |

## What `npm install`s and why

- `fastify` + `@fastify/static` + `@fastify/formbody` — HTTP server
- `dockerode` + `@types/dockerode` — Docker socket client
- `bcryptjs` + `@types/bcryptjs` — password hashing for user mgmt
  (pure JS so no native build step in the Alpine image)

## Workspace image contents (per-user `browser-linux-workspace:latest`)

- Base: `node:20-bookworm-slim` (Debian 12 + Node 20)
- Apt: ca-certificates, curl, wget, git, sudo, tini, build-essential,
  python3 + pip + venv, vim, nano, less, jq, tmux, htop, iproute2 (`ss`),
  procps, openssh-client, gnupg, unzip, zip, file, man-db
- Binaries:
  - `ttyd` (port 7681) — browser terminal
  - `filebrowser` (port 7682) — drag-drop file manager,
    DB pre-baked at `/usr/local/share/filebrowser/filebrowser.db` with
    `auth.method=noauth`, dark theme, no external links
  - `KasmVNC` + `XFCE4` + `firefox-esr` + `xfce4-terminal` + `thunar`
    (port 7683) — graphical desktop. KasmVNC's `subpath` is set per-
    container via `VNC_BASEURL=/u/<user>/desktop` env, written to
    `~/.vnc/kasmvnc.yaml` by entrypoint.sh. No KasmVNC-layer auth.
  - `claude` (Claude Code CLI, npm global)
- User: `node` (uid 1000) with passwordless sudo
- Entrypoint: `tini → entrypoint.sh → (filebrowser bg) + (KasmVNC+XFCE bg) + (ttyd fg)`
- Image size with GUI ~2 GB; runtime RAM ~250 MB idle, ~1 GB with Firefox open.

## Things explicitly NOT to do

- ❌ `git add caddy/users.users` or `caddy/admins.users` — they are gitignored on purpose; committing them leaks bcrypt hashes
- ❌ Set the repo back to **Public** without re-auditing what's tracked
- ❌ `docker run -p` to publish workspace ports — proxy already does it via `/u/<user>/p/<port>/`
- ❌ Add new Azure NSG inbound rules per workspace — only 8080 (or 80/443 in prod) needs to be open
- ❌ Use SSH tunnels to expose webapps — same proxy serves them
- ❌ Run anything on port 80 inside the container — non-root, capability not granted
- ❌ Use Tailscale / ngrok / cloudflared inside workspaces — overkill, the proxy already does this
- ❌ Bind workspace services to `127.0.0.1` — Caddy can't reach them; bind `0.0.0.0`
- ❌ Add custom auth code in the portal — Caddy + `X-Auth-User` is the contract
- ❌ Trust `req.body` shapes blindly — every route casts via inline interface

## Roadmap

| Version | Goal |
|---|---|
| **v0.9.x** (current) | XFCE4 GUI desktop + Firefox via KasmVNC at `/u/<user>/desktop/` |
| v0.7.x | Filebrowser embedded, dark mode |
| v0.8 | Auto-refresh ports sidebar (HTMX or small JS poll); workspace template variants (Python-heavy / Go-heavy / etc.) |
| **v1.5** | Replace basic_auth with oauth2-proxy + Entra ID OIDC. Caddyfile swap; portal code unchanged because of the X-Auth-User contract. |
| v2.0 | Per-user Anthropic API key storage (encrypted, libsodium), audit log to Postgres, group→admin sync from IdP |
| v2.5 | Workspace sharing (invite links), public file viewer for `~/public`, snapshot/clone |

## Open improvements / debt

- **Cache the listening-ports lookup** — currently runs `ss -tln` via Docker exec on every dashboard load. ~50–100 ms per workspace; fine for now.
- **Filebrowser DB is regenerated on every container start** — cheap, but if we ever want filebrowser per-user prefs, we'd need to persist.
- **Idle reaper** is a host cron parsing Caddy access logs. Move into the portal as an in-process scheduler when we have more workspaces.
- **No automated tests** — manual smoke test only. Sketched but not written: a tiny e2e using `curl --user` against the live stack.
- **No Terraform** — Azure infra is click-ops via the portal. `infra/terraform/` is documented but empty.
- **Backups** — script in README, not automated.

## Git workflow

- Branch: `main`, force-push avoided
- Author identity for AI-assisted commits:
  ```
  Justin Cronin <justin.cronin@ntiva.com>
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Commit messages: focus on **why**, not what. Multi-line for non-trivial changes. Conventional-style prefix: `feat(scope):`, `fix(scope):`, `docs:`, `debug(scope):`.
- Bump `portal/package.json` version on every user-visible change. The footer reads it at runtime, so the version is always live-truth.

## Conventions for in-workspace Claude sessions

The portal's dashboard has a **paste-ready briefing block** (`/app` → "Hosting a webapp from your workspace" → expand "Paste this into Claude inside your workspace"). When a user wants to develop or test a webapp inside their container and asks Claude in there for help, that block prevents the in-container Claude from suggesting wrong fixes (port publishing, NSG rules, SSH tunnels, etc.). It tells Claude:

1. Bind `0.0.0.0:<port>`, never `127.0.0.1`
2. URL: `http://<host>:8080/u/<user>/p/<port>/`
3. Use relative URLs in HTML (or `<base href>`)
4. Don't suggest `docker run -p`, NSG, SSH tunnels, port 80, ngrok, cloudflared, Tailscale

Future feature (not yet built): bake `/etc/CLAUDE.md` and an `entrypoint.sh`-managed `~/CLAUDE.md` symlink so in-container Claude reads this convention without a paste.
