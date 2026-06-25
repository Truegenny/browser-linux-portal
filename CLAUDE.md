# ClaudeLab — project context

(Repo is still named `browser-linux-portal` on GitHub for the moment; the
product/brand is **ClaudeLab**. Rename the repo when convenient — the URL
update is a follow-up.)

A self-hosted dev workspace platform. One Linux VM, Docker, a per-user Debian
container with `claude` (Claude Code CLI), `ttyd` (browser terminal), and
`filebrowser` (drag-and-drop file manager). Caddy fronts everything with
Entra ID SSO via oauth2-proxy. Marketed as a small alternative to
Coder / Codespaces / WebVM.

Repo: https://github.com/Truegenny/browser-linux-portal (private — verify before pushing anything sensitive)

If you're a fresh Claude session: **read the README first, then this file,
then `docs/SSO.md` if you're touching anything auth-related.**

---

## Current state

- **Version:** see `portal/package.json` (`v1.0.0`+ at time of writing — first prod release with SSO)
- **Auth:** Entra ID via oauth2-proxy. Basic-auth is GONE — no more `users.users`/`admins.users`/`add-user.sh`.
- **Deployment target:** new Azure subscription (TBD), greenfield. The old `ClaudeDocker` VM at 20.125.57.59 is the dev/staging history; production lives elsewhere.
- **Stack name:** `claudelab` (compose project)
- **Production FQDN:** `claudelab.ntiva.com`
- **Public ports (prod):** 80, 443. TLS via Let's Encrypt against `SITE_ADDRESS`.

## Architecture

```
  Browser
    │  HTTPS (Let's Encrypt cert managed by Caddy)
    ▼
┌─────────┐   forward_auth ──→ ┌───────────────┐
│  Caddy  │  ←── X-Auth-Req-* ─│ oauth2-proxy  │ ──→ Entra ID OIDC
└────┬────┘                    └───────────────┘
     │  copies X-Auth-Request-{Email,Groups} onto inbound request
     │
     ├── portal-net ────→ portal:3000      (control plane)
     │     ├──→ /                   public marketing page              (portal)
     │     ├──→ /app, /admin, /api  authed dashboard / admin / API     (portal)
     │     └──→ /oauth2/*           login/callback/sign_out            (oauth2-proxy)
     │
     └── workspace-net ─→ ws-<slug>      (data plane; portal NOT on this net)
           ├──→ /u/<slug>/desktop/<…> →  ws-<slug>:7683   (KasmVNC + XFCE4 GUI)
           ├──→ /u/<slug>/files/<…>   →  ws-<slug>:7682   (filebrowser)
           ├──→ /u/<slug>/p/<port>/<…> →  ws-<slug>:<port> (user webapp)
           ├──→ /u/<slug>/<…>         →  ws-<slug>:7681   (ttyd terminal)
           └──→ /admin/term/<target>/<…> → ws-<target>:7681   (admin-only)
```

Slug = lowercase local-part of the user's Entra email. `justin.cronin@ntiva.com`
→ `justin.cronin`. Caddy captures it from `X-Auth-Request-Email` via a
`header_regexp` matcher; the portal does the same derivation in
`lib/users.ts::slugFromEmail`. If those ever drift, `/u/...` routes to a
different container than the portal thinks the user owns — keep them in sync.

Four services in compose: `caddy`, `oauth2-proxy`, `portal`, and a one-shot
`workspace-image-builder` (builds the per-user image, exits 0). Workspace
containers (`ws-<slug>`) are spawned dynamically by the portal via the
Docker socket as users sign in. Caddy is the only service attached to
both networks; the portal is deliberately isolated from `workspace-net`
so a compromised workspace can't reach `portal:3000` and forge headers.

## Critical conventions (don't break these)

1. **Route by auth identity, not URL slot.** Every `/u/<slot>/...` route
   ignores `<slot>` and proxies to `ws-<slug>:...` where `<slug>` is
   derived from the authenticated user's email. This is more secure than
   comparing slot to auth (no way to even attempt cross-user access) and
   we proved the alternative — CEL expression matchers and placeholder
   substitution in `path_regexp` patterns — is fragile.

   **Exception 1 — admin paths**: `/admin/term/<target>/...` routes by
   URL slot, with the variant suffixes for service: bare → terminal,
   `/p/<port>/` → webapp port, `/desktop/...` → KasmVNC (mirrors the
   user-side redirect-with-`?path=` trick for the noVNC client).
   Gated in Caddy by a `forward_auth` subrequest to the portal's
   `/internal/check-admin`, which unions three signals: Entra group
   OID, `admins.users` file, and `ADMIN_USERS` env — any one makes the
   requester admin.

   File browsing cross-user is NOT served by filebrowser (its baked-in
   `--baseurl` doesn't compose with a different prefix). Instead the
   portal renders `/admin/files/<target>/` itself, using `docker exec
   ls`/`head` to read the workspace's `/home/node`. Read-only,
   download-only — uploads happen via the admin terminal (e.g.
   `cat > foo` over the shared PTY).

   **Exception 2 — shared webapps**: `/shared/<sharer>/p/<port>/...`
   routes by URL slot to `ws-<sharer>:<port>`. Authenticated (any
   signed-in user passes the outer forward_auth) but no admin
   requirement. Gated by a `forward_auth` to the portal's
   `/internal/check-shared` which validates the `(sharer, port)` pair
   against `caddy/shared.ports` — a sharer-managed list set from the
   dashboard's port sidebar.

2. **Workspace ports must bind `0.0.0.0`** to be reachable through the
   proxy. `127.0.0.1` works inside the container but is unreachable from
   Caddy on `workspace-net`. The dashboard ports sidebar flags loopback
   binds explicitly.

3. **Auth contract is `X-Auth-User` + `X-Auth-Groups` headers.** Caddy
   gets these from oauth2-proxy via `forward_auth` and re-emits them on
   the upstream request. The portal trusts them because (a) the portal
   is never published — only Caddy is, and (b) workspace containers
   live on `workspace-net` which the portal is NOT attached to, so they
   can't reach `portal:3000` to forge headers from inside a shell.
   **Never attach the portal to `workspace-net`** — that re-opens the
   bypass.

   Additionally, the portal rejects cross-origin state-changing requests
   via an `onRequest` hook (`portal/src/lib/csrf.ts`) that checks
   `Sec-Fetch-Site` + `Origin`. Defence in depth alongside oauth2-proxy's
   own session cookie + SameSite=Lax.

4. **Username regex everywhere:** `^[a-z0-9][a-z0-9._-]{0,40}$`. Defined
   in `portal/src/lib/users.ts` (`USERNAME_RE`) and mirrored verbatim in
   the Caddyfile's `path_regexp` matchers and `header_regexp` slug
   capture. Don't relax; it's load-bearing for safe interpolation into
   URLs, container names, volume names, and shell args. Dots are
   allowed only because email local-parts contain them — Docker accepts
   them in container names, and URLs render them fine.

5. **Workspace identity = auth identity.** Container `ws-<user>`,
   volume `ws-<user>-home` mounted at `/home/node`. The in-container
   user is the upstream `node` user (uid 1000) from `node:20-bookworm-slim`
   — we do *not* `useradd` (the slim image strips `passwd` package).

## Top-level layout

```
caddy/                 — Caddyfile + desktop.users.example
                         (real desktop.users is GITIGNORED, managed via
                          the /admin/users UI at runtime)
portal/                — Fastify + TS app
  src/
    server.ts          — routes
    lib/
      auth.ts          — reads X-Auth-User/X-Auth-Groups headers
      config.ts        — env loader (incl. ADMIN_GROUP_OID)
      csrf.ts          — onRequest CSRF guard for state-changing methods
      dockerctl.ts     — workspace lifecycle, port-listing via `ss -tln`
      html.ts          — layout helper (header/footer + version)
      users.ts         — slug derivation + desktop.users helpers
      version.ts       — reads package.json at runtime
    views/             — server-rendered HTML (template literals)
  public/styles.css    — single dark-themed stylesheet
workspace-image/       — Dockerfile + entrypoint for terminal/desktop tiers
                         (Debian 12; GUI gated by ENABLE_DESKTOP)
workspace-image-power/ — Dockerfile + entrypoint for the POWER tier
                         (Ubuntu 24.04 + KDE Plasma + full Playwright)
scripts/               — build-workspace-image.sh, idle-stop.sh
docs/
  DEPLOY.md            — Ubuntu/Azure deploy runbook (start here)
  SSO.md               — Entra ID app-registration + claims walkthrough
  RESIZE-REBOOT-RECOVERY.md — what to do when the VM comes back from an
                         Azure resize / reboot and the site is down (data-disk
                         remount, the `docker compose down && up -d` network
                         fix, DNS/public-IP checks)
```

## Webapp sharing

Two-layer model:

**Layer 1 — admin capability gate (`caddy/sharing-allowed.users`).**
Admin flips an `Allow sharing` toggle for a user from `/admin/users`.
Default-off: a fresh user has no Share buttons visible until an admin
grants the capability. Toggling off acts as a kill-switch — the
portal wipes every entry in `shared.ports` for that user as part of
`setSharingAllowed(slug, false)`.

**Layer 2 — per-port user toggle (`caddy/shared.ports`).**
A capability-granted user clicks `Share` on any webapp port from their
dashboard sidebar. The portal records the `(sharer, port)` pair and
surfaces the URL `/shared/<sharer>/p/<port>/` for any signed-in user
to visit. Auth still applies — sharing only lifts the "workspace
identity must match auth identity" routing constraint.

Implementation:
- `lib/users.ts` — `listSharedPorts`/`isShared`/`setShared` for ports;
  `listSharingAllowed`/`isSharingAllowed`/`setSharingAllowed` for the
  capability gate (latter wipes ports on disable)
- `POST /api/share/:port` — sharer's toggle. Verifies the user is
  sharing-allowed before accepting `share=on`; always accepts
  `share=off` so users can revoke their own state even post-revoke
- `GET /internal/check-shared` — Caddy `forward_auth` subrequest.
  Re-checks both layers (sharing-allowed AND in shared.ports) so a
  stale `shared.ports` entry can never grant access if capability
  was revoked
- `POST /admin/users/:target/{allow,disallow}-sharing` — admin
  toggles on `/admin/users`

## Admin status — three sources, unioned

A user is admin if **any** of these is true (checked in `lib/auth.ts`):

1. Their email is listed in the `ADMIN_USERS` env var (bootstrap; survives
   when Entra/file are unavailable).
2. Their token's `groups` claim contains the OID configured as
   `ADMIN_GROUP_OID` (the canonical "real" admin signal — managed in Entra).
3. Their email is listed in `caddy/admins.users` (portal-elected; managed
   from the `/admin/users` UI by another admin).

Caddy gates `/admin/term/<target>/*` via a `forward_auth` subrequest to
the portal's `/internal/check-admin` — which performs exactly the union
above. This means file-elected admins get full cross-user access too,
without needing Entra group membership.

`admins.users` is gitignored and lives next to `desktop.users`. Demotion
of a portal-elected admin takes effect on the next page load. Demotion
via Entra group only takes effect on token refresh (cookie lifetime is
8h by default).

## User tiers (terminal / desktop / power)

Each user is one of three tiers, editable per-user from `/admin/users`
(a single tier dropdown → `POST /admin/users/:target/tier`):

- **terminal** (default) — ttyd + filebrowser only. 2 GB RAM. ~80 MB idle.
- **desktop** — adds KasmVNC + XFCE4 + Firefox (lite GUI). 3 GB RAM. ~250 MB idle.
- **power** — *separate Ubuntu 24.04 image* (`claudelab-workspace-power`):
  KDE Plasma + Google Chrome + the full Playwright suite
  (chromium/firefox/webkit) + computer-use tooling
  (`xdotool`/`scrot`/`wmctrl`/`imagemagick`). For Claude cowork + Playwright
  power users. 6 GB RAM, 4 CPUs, 2 GB `/dev/shm` by default. Rare, opt-in.

**Tier storage.** terminal/desktop membership lives in
`caddy/desktop.users`; power membership in `caddy/power.users`. Both are
plain one-username-per-line lists, gitignored, portal-side only (Caddy
never reads them). `getUserTier` resolves with **power > desktop >
terminal** precedence; `setUserTier` reconciles both files so a user is
never in two at once. The portal sets `ENABLE_DESKTOP=0|1` (0 only for
terminal) and picks the image + memory/shm/CPU caps per tier in
`dockerctl.ts::tierResources`.

**Two images, not one.** terminal + desktop share the Debian
`workspace-image/` (one image, GUI gated by `ENABLE_DESKTOP`). Power uses
the distinct Ubuntu `workspace-image-power/`. Both normalize to the same
identity (`node` user, uid 1000, `/home/node`) so the **same
`ws-<user>-home` volume works across a tier switch** — a user moving
desktop→power keeps their data. (Ubuntu's stock uid-1000 `ubuntu` user is
renamed to `node` in the power Dockerfile for exactly this reason.)

Tier changes are **lazy**: the running container keeps its current tier
until the user (or admin) stops + starts it. The portal detects the
mismatch on the next start (`readContainerTier` vs requested tier) and
destroys + recreates the container, preserving the home volume. The
current container's tier is shown in `/admin` → Workspaces → Tier column.

> Switching to/from **power** swaps the whole image (Debian↔Ubuntu) on that
> recreate. Home data survives; anything in the container layer (sudo
> apt-installed packages, global npm tools) does not — same caveat as
> Recreate, just also crossing distros.

## Key knobs (`.env` → compose env)

- `SITE_ADDRESS` — production FQDN (e.g. `workspaces.ntiva.com`). Caddy
  site label AND oauth2-proxy cookie domain. SSO requires HTTPS so this
  must be a real DNS name with ports 80+443 reachable.
- `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` — host port mappings (80/443 in prod)
- `OIDC_TENANT_ID` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` — Entra app registration
- `OAUTH2_PROXY_COOKIE_SECRET` — 32 random bytes, base64. Rotating it logs everyone out.
- `OAUTH2_PROXY_EMAIL_DOMAINS` — comma-separated allowlist (e.g. `ntiva.com`)
- `ADMIN_GROUP_OID` — Entra security group whose members get admin
- `ADMIN_USERS` — bootstrap admin allowlist by email (fallback / first-sign-in)
- `WORKSPACE_MEMORY_TERMINAL` (2g) / `WORKSPACE_MEMORY_DESKTOP` (3g) / `WORKSPACE_MEMORY_POWER` (6g) — per-tier RAM caps
- `WORKSPACE_IMAGE` (Debian terminal/desktop) / `WORKSPACE_IMAGE_POWER` (Ubuntu power image)
- `WORKSPACE_SHM_SIZE` (512m) / `WORKSPACE_SHM_SIZE_POWER` (2g) — `/dev/shm` per tier
- `WORKSPACE_CPUS` (1.5) / `WORKSPACE_CPUS_POWER` (4) — CPU caps (power gets its own)
- `WORKSPACE_IDLE_HOURS` — per-container idle limit

## Common commands (inside the project root)

```bash
# Rebuild workspace image (after Dockerfile changes); ~5-10 min
docker compose build --no-cache workspace-image

# Rebuild the POWER workspace image (Ubuntu/KDE/Playwright); ~10-20 min, big
docker compose build --no-cache workspace-image-power

# Standard deploy that doesn't use the power tier can skip the heavy build:
docker compose build workspace-image portal

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

# One-time migration to v0.9.18 network split: move any pre-existing
# workspace containers off portal-net and onto workspace-net. Required
# only once per host after first deploying v0.9.18+; new workspaces
# created after the upgrade go straight to workspace-net.
for c in $(docker ps -aq --filter "name=^ws-"); do
  docker network connect    workspace-net "$c" 2>/dev/null || true
  docker network disconnect portal-net    "$c" 2>/dev/null || true
done

# One-time migration to v0.9.19 user tiers: pre-populate caddy/desktop.users
# with every existing username so current users keep their GUI. New users
# default to terminal-only; admins can flip them in /admin/users. Run on
# the host where the repo is checked out (writes ./caddy/desktop.users).
(
  echo '# Users with the desktop GUI enabled. Managed by the portal /admin/users UI.'
  echo '# Pre-populated from existing users.users by v0.9.19 migration.'
  awk '{print $1}' caddy/users.users | grep -v '^#' | grep -v '^$'
) > caddy/desktop.users
# Then force-remove each user's container so the next Start recreates it
# with the correct ENABLE_DESKTOP env + tier label. The ws-<user>-home
# volume is preserved by name, so user data survives.
for c in $(docker ps -aq --filter "name=^ws-"); do docker rm -f "$c"; done
```

## Bugs we hit and how we fixed them (so future you doesn't repeat them)

### Build-time

| Symptom | Cause | Fix |
|---|---|---|
| `exit 127` on `useradd -u 1000 dev` | `passwd` package stripped from `node:20-bookworm-slim` | Reuse the upstream `node` user (uid 1000); don't `useradd` |
| `usermod: not found` (exit 127) renaming `ubuntu`→`node` in the power image | The Dockerfile `ENV PATH` omitted `/usr/sbin` — `usermod`/`groupmod` (and `make-ssl-cert`) live there; `passwd` pkg was present all along | Put `/usr/sbin:/sbin` in the power Dockerfile's `ENV PATH`. Also needed at runtime so the portal's `ss` exec resolves |
| `chown: cannot access '/usr/local/lib/node_modules'` in the power image | NodeSource Node puts npm's global prefix at `/usr` (`/usr/lib/node_modules`, `/usr/bin`), not `/usr/local` like the official `node` image | Pin `npm_config_prefix=/usr/local` (ENV) so globals install under `/usr/local` and can be safely chown'd to `node` — don't chown `/usr/bin` |
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
(bcryptjs was removed in v1.0 — no more local password hashing. Entra
owns identity now.)

## Workspace image contents (per-user `claudelab-workspace:latest`)

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

## Power image contents (`claudelab-workspace-power:latest`)

Built from `workspace-image-power/`. Same three-service model + ports
(7681/7682/7683) and the same `node`/uid-1000/`/home/node` identity as the
Debian image (so volumes are interchangeable across tiers), but:

- Base: `ubuntu:24.04` + Node 22 (NodeSource). Ubuntu's stock uid-1000
  `ubuntu` user is renamed to `node` with `/home/node` (see Dockerfile §1).
- Desktop: **KDE Plasma** (X11) over KasmVNC instead of XFCE. Launched via
  `startplasma-x11` in entrypoint.sh; sddm is present but never started
  (no init in-container). Default resolution 1920×1080.
- Browsers: **Google Chrome** (`google-chrome-stable`) baked, plus the
  **Playwright** OS dependencies for all three engines (via `playwright
  install-deps`). The Playwright **browser binaries are NOT baked** and
  `PLAYWRIGHT_BROWSERS_PATH` is deliberately **unset** — each project runs
  `npx playwright install` once, which fetches the browsers matching *its*
  Playwright version into `~/.cache/ms-playwright` on the persistent home
  volume (no sudo needed, deps are present). See the **Playwright in the power
  tier** note below for why baking to `/opt` was removed.
- Computer-use tooling: `xdotool`, `wmctrl`, `scrot`, `imagemagick`,
  `xclip`, `x11-apps`. `DISPLAY=:1` is exported in `.bashrc` so headed
  browsers / xdotool from the terminal render onto the visible desktop.
- **KDE screen locker is disabled** (`kscreenlockerrc` `Autolock=false` +
  `LockOnResume=false`, both system-wide in `/etc/xdg` and re-written per-user
  by entrypoint.sh on every start). The `node` user has no system password —
  auth is at oauth2-proxy — so any lock screen (idle timeout, VNC
  reconnect) would be an unrecoverable lockout. Don't re-enable it.
- Same hardened posture as the lite image — `no-new-privileges` + dropped
  caps + no user namespaces — so Chromium/Chrome **must** run `--no-sandbox`
  (the SUID/userns sandbox can't initialize; without the flag Chrome exits
  instantly and silently). The Google Chrome launcher is therefore wrapped:
  `/usr/local/bin/google-chrome-stable` (ahead of `/usr/bin` on PATH) injects
  `--no-sandbox --test-type`, and `google-chrome.desktop`'s Exec lines are
  repointed at it, so both the KDE menu icon and terminal/agent launches get
  the flag. Playwright's own chromium is separate — pass `--no-sandbox` (or
  `chromiumSandbox: false`) in the script. Playwright **Firefox** has its
  content sandbox disabled for users via `MOZ_DISABLE_CONTENT_SANDBOX=1` (image
  ENV), since the same userns block would otherwise crash its renderer headed.
  The portal gives this tier a real 2 GB `/dev/shm`, so do **not** use
  `--disable-dev-shm-usage`.
- Image size ~3–4 GB (browser binaries no longer baked); build ~10–20 min.
  Runtime RAM is the reason for the 6 GB cap — KDE + multiple headed browsers.

### Playwright in the power tier

Browsers are **per-project**, not baked. In a project:
```bash
npm i -D @playwright/test        # or whatever pins the project's PW version
npx playwright install           # downloads matching browsers to ~/.cache/ms-playwright
```
Why not baked: the image briefly set `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`
and pre-installed browsers there. That **locked every project to the image's
exact Playwright version** — a project on PW 1.60 needs firefox-1522, but the
image baked firefox-1532, so launches failed with "Executable doesn't exist"
or the page closed instantly (incompatible Juggler protocol). `/opt` was also
root-owned (can't install matching builds) and the global shell var meant a
project's own `.env` couldn't override it. Removing the var + the bake fixes
all of that; OS deps stay baked so `npx playwright install` needs no sudo.

Gotchas in this container (document for in-workspace Claude):
- **Chromium**: launch with `args: ['--no-sandbox']` (userns blocked).
- **Firefox**: content sandbox already disabled via `MOZ_DISABLE_CONTENT_SANDBOX=1`.
- **WebKit**: works headless with the baked deps.
- Headed runs render on `DISPLAY=:1` (KasmVNC/KDE).
- `/dev/shm` is 2 GB — shm size is not the crash cause; don't reach for `--disable-dev-shm-usage`.
- Don't `pkill -f firefox`/`-f chromium` from a command line that itself contains
  those strings — `pkill -f` matches the full command line and can SIGKILL its
  own shell. Match by process name (`pkill -x`) or profile dir instead.

## Things explicitly NOT to do

- ❌ `git add caddy/desktop.users` — gitignored on purpose (per-deployment runtime state)
- ❌ Re-introduce `users.users` / `admins.users` / `add-user.sh` — identity is Entra's job now; local user management defeats SSO
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
| v0.7.x | Filebrowser embedded, dark mode |
| v0.8 | Auto-refresh ports sidebar (HTMX or small JS poll); workspace template variants (Python-heavy / Go-heavy / etc.) |
| v0.9.x | XFCE4 GUI desktop + Firefox via KasmVNC at `/u/<user>/desktop/`; per-user terminal/desktop tiers; admin cross-user terminal + logs |
| **v1.0 (current)** | Entra ID SSO via oauth2-proxy; basic-auth retired; admin via Entra group OID; first production deploy |
| v2.0 | Per-user Anthropic API key storage (encrypted, libsodium), audit log to Postgres |
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
