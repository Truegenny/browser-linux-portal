# ClaudeLab

Self-hosted dev workspace platform. One Linux VM, Docker, a per-user container
with `claude` (Claude Code CLI) preinstalled, accessible from any browser via
xterm.js + ttyd. Authenticated through Entra ID single sign-on.

> ⚠️ **The body of this README still describes the pre-v1.0 basic-auth
> scaffold and is out of date.** For production deployment use
> [docs/DEPLOY.md](docs/DEPLOY.md) and [docs/SSO.md](docs/SSO.md);
> for the architecture and conventions read [CLAUDE.md](CLAUDE.md).
> A full README refresh is a TODO.

> **Status:** v0 scaffold. Auth is **HTTP basic auth** today; **Entra ID SSO**
> is planned for v1.5 (the auth contract — `X-Auth-User` header — is identical
> across both modes, so the migration is a Caddyfile swap, not a refactor).

---

## Architecture

```
  Browser
    │  HTTPS + WSS
    ▼
┌─────────────┐  basic_auth (today) → oauth2-proxy + Entra (v1.5)
│   Caddy     │  • TLS termination (auto Let's Encrypt in prod)
│             │  • routes /, /app, /admin, /u/{user}/* to portal or workspace
└──────┬──────┘
       │ X-Auth-User: <user>
       ▼
┌─────────────────────────────────────────┐
│  Portal  (Node 20 + TS, Fastify)        │  • marketing page (PUBLIC)
│                                         │  • /app dashboard (AUTHED)
│  ┌─────────┐    ┌────────────────────┐  │  • /admin (admin allowlist)
│  │ Routes  │──▶ │ dockerctl (socket) │──┼─▶  /var/run/docker.sock
│  └─────────┘    └────────────────────┘  │
└─────────────────────────────────────────┘
                      │ creates / starts / stops
                      ▼
            ┌──────────────────────────┐
            │  ws-<user>               │  Container per Entra/basicauth user
            │  Debian 12 + Node 20 +   │
            │  Claude Code + ttyd      │
            │  /home/node → ws-<user>-home volume
            └──────────────────────────┘
```

## Quickstart (local dev on Linux)

Requires: Docker + docker compose. No Node install needed on the host.

```bash
cp .env.example .env
# Edit .env if you want to change ports / limits.

# 1) Build the workspace image (Debian + node + claude + ttyd, ~1 GB)
./scripts/build-workspace-image.sh

# 2) Create your first user (interactive prompt for password)
./scripts/add-user.sh admin --admin

# 3) Bring it up
docker compose up -d --build

# 4) Visit it
#    Marketing page:   http://localhost:8080/
#    Sign in to /app:  http://localhost:8080/app   (basicauth: admin / yourpw)
#    Admin:            http://localhost:8080/admin
```

On `localhost`, Caddy uses its internal CA — your browser will warn about the
self-signed HTTPS cert if you go to `:8443`. Use plain HTTP at `:8080` for dev.

### Day 0–1: prove it works

After step 4 above:

1. Visit `/`, click "Sign in", enter `admin` + your password.
2. Click **Create my workspace** — first time takes a few seconds.
3. Click **Open terminal** → a new tab opens with bash inside your container.
4. Run `claude /login` to authenticate Claude Code.
5. Run `claude` — chat with Claude.

Close the tab. Stop the workspace from `/app` if you want. Your `/home/node`
contents persist in the `ws-admin-home` Docker volume.

## Directory layout

```
claudelab/
├── caddy/
│   ├── Caddyfile             # routing + basicauth gates
│   ├── users.users           # user→bcrypt-hash entries (managed by add-user.sh)
│   └── admins.users          # admin subset (extra gate for /admin)
├── portal/                   # Node + TS web app
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── public/
│   │   └── styles.css
│   └── src/
│       ├── server.ts         # Fastify bootstrap + routes
│       ├── lib/
│       │   ├── auth.ts       # X-Auth-User header reader + admin check
│       │   ├── config.ts     # env loader
│       │   ├── dockerctl.ts  # workspace lifecycle via Docker socket
│       │   └── html.ts       # tiny escaping + layout helper
│       └── views/
│           ├── marketing.ts  # public landing page (LinuxOnTab style)
│           ├── dashboard.ts  # /app — per-user workspace status + actions
│           └── admin.ts      # /admin — table of all workspaces + actions
├── workspace-image/
│   ├── Dockerfile            # Debian 12 + Node 20 + claude + ttyd
│   ├── entrypoint.sh         # launches ttyd on :7681 wrapping bash
│   └── motd
├── scripts/
│   ├── add-user.sh           # bcrypt + write to users.users (and admins.users)
│   ├── build-workspace-image.sh
│   └── idle-stop.sh          # cron job: stop containers idle > N hours
├── docker-compose.yml        # caddy + portal services
├── .env.example
└── README.md  (this file)
```

## Operations

### Adding / removing users

```bash
./scripts/add-user.sh alice              # regular user
./scripts/add-user.sh bob   --admin      # admin

# Apply changes:
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

For admins, also list them in `ADMIN_USERS` in `.env` and restart the portal:

```bash
docker compose up -d portal
```

To remove a user, edit the `caddy/users.users` (and `admins.users`) files and
reload Caddy.

### Backups

User data lives in named volumes `ws-<user>-home`. Tar them on a schedule:

```bash
docker run --rm -v ws-alice-home:/data -v "$PWD/backups:/out" alpine \
  tar czf /out/alice-$(date +%F).tgz -C /data .
```

### Idle reaper

Schedule via host cron:

```cron
*/15 * * * *  /opt/claudelab/scripts/idle-stop.sh >> /var/log/claudelab-idle.log 2>&1
```

The script reads Caddy's JSON access log to determine activity per workspace.

### Watching logs

```bash
docker compose logs -f portal
docker compose logs -f caddy
docker compose exec caddy tail -f /var/log/caddy/access.log
```

## Day-by-day plan (ref)

| Day | Goal | Status |
|-----|------|--------|
| 1 | Caddy + portal + basicauth → "hello" page | ✅ scaffold here |
| 2 | Workspace image + first manual `ws-<me>` + terminal works | ✅ scaffold here |
| 3 | Spawner: portal creates workspaces on demand from `/app` | ✅ scaffold here |
| 4 | Marketing landing page polished | ✅ scaffold here |
| 5 | Admin UI + log viewer | ✅ scaffold here |
| 6 | Hardening: TLS in prod, idle reaper cron, backups | ⏳ stubs in place |
| 7 | Runbook + Azure deployment notes | ⏳ this README |

## Roadmap

- **v1.0** — scaffold above + hardening, Azure deployment runbook, backup automation
- **v1.5** — replace `basic_auth` with `oauth2-proxy` + Microsoft Entra ID; group→admin mapping
- **v2.0** — per-user Anthropic API key (encrypted in Postgres), audit log, multiple workspace templates
- **v2.5** — workspace sharing (invite links), file viewer for `~/public`, snapshot/clone

## Security notes

- **Containers are not VMs.** Sudo is enabled by default. Don't host this in
  front of untrusted users until you've thought about kernel sandbox bypasses.
  For trusted teammates, the standard container isolation is acceptable.
- **The portal trusts `X-Auth-User` from Caddy.** Caddy is the only ingress;
  do not publish the portal's port directly to the internet.
- **Docker socket access** is granted to the portal. The portal effectively
  has root on the host. Treat it accordingly.
- **Per-user volumes** persist everything in `/home/node`, including any API
  keys the user pastes. Volumes are not encrypted at rest by Docker. Use
  Azure Disk Encryption on the data disk.

## Deploying

**Recommended:** direct on a clean Ubuntu VM — see [`docs/DEPLOY.md`](docs/DEPLOY.md).
The runbook covers Docker install, repo clone with private auth, env config,
NSG, systemd unit, idle reaper, backups, and troubleshooting.

The Portainer Stack-from-Git path below works but has more moving parts and
is finicky around bind-mount state when deploys fail mid-way. Use it only if
Portainer is part of your existing workflow.

## Portainer deployment (alternative, more fragile)

This repo is set up to be deployed as a **Portainer Stack from Git**. The
workspace image is built as part of the stack (the `workspace-image` service
in compose builds `claudelab-workspace:latest` and then exits — that's
expected; you'll see one container in "Exited (0)" state).

### One-time on the Portainer host

```bash
# Caddy needs to read the bind-mounted users files; create them if absent
# (the repo provides empty placeholders, but Portainer pulls into a fresh
# directory).
sudo mkdir -p /opt/claudelab/caddy
```

You only need this if you want to manage user files outside the repo. If
you're fine with `add-user.sh` writing into the repo's working tree on the
host, skip it.

### Create the stack

In Portainer:

1. **Stacks → Add stack → Repository**
2. **Repository URL:** `https://github.com/Truegenny/browser-linux-portal`  *(private — add a Personal Access Token in Portainer's Git credentials)*
3. **Compose path:** `docker-compose.yml`
4. **Environment variables** (paste / set in the UI):
   ```
   DOMAIN=box.yourdomain.com           # public hostname; DNS A record must point here
   ACME_EMAIL=you@yourdomain.com
   CADDY_HTTP_PORT=80
   CADDY_HTTPS_PORT=443
   ADMIN_USERS=admin
   WORKSPACE_MEMORY=2g
   WORKSPACE_CPUS=1.5
   WORKSPACE_IDLE_HOURS=2
   ```
5. **Auto-update** (optional): turn on "Re-pull image and redeploy" with a
   webhook or polling interval if you want pushed commits to deploy
   automatically.
6. **Deploy the stack.** First deploy takes a few minutes (the workspace
   image is ~1 GB and builds Node + claude-code).

### Add the first user

After the stack is up, SSH to the Portainer host (or use Portainer's
"Console" tab on the `caddy` container — `add-user.sh` runs from the host,
not the container, so SSH is easier):

```bash
cd /var/lib/docker/volumes/<stack-volume>/...
# OR, simpler — clone the repo to a known path and run from there:
git clone https://github.com/Truegenny/browser-linux-portal.git /opt/claudelab
cd /opt/blp
./scripts/add-user.sh admin --admin

# Then reload Caddy in the running stack:
docker compose -f /opt/blp/docker-compose.yml exec caddy \
    caddy reload --config /etc/caddy/Caddyfile
```

Or shorter: bash into the caddy container and edit `/etc/caddy/users.users`
directly with a hash you generate via:

```bash
docker exec caddy caddy hash-password --plaintext 'mypassword'
```

### Open the site

Browse to `https://box.yourdomain.com/`. Caddy obtains a Let's Encrypt cert
on first hit (assuming port 80/443 reachable from the internet). Sign in
to `/app` with your basicauth credentials.

### Updating

- **Code changes pushed to GitHub** → Portainer Stack → "Pull and redeploy"
- **Workspace image changes** (e.g. bumping Node, adding tools): same
  redeploy — the `workspace-image` service rebuilds the image. Existing
  user containers continue to run on the *old* image; they pick up the new
  one only after destroy + recreate (admin can do this from `/admin`).

## Azure deployment (manual, alternative to Portainer)

If you don't have Portainer and want to deploy directly:

1. Spin up Ubuntu 22.04 VM (B4ms recommended; 4 vCPU / 16 GB / Premium SSD).
2. Attach a 256 GB Premium SSD data disk for `/var/lib/docker`.
3. Install Docker (`curl https://get.docker.com | sh`) and add yourself to the `docker` group.
4. Open NSG: 443 + 80 to internet, 22 to your IP only.
5. Point a DNS A record at the VM's public IP.
6. `git clone`, edit `.env` (`DOMAIN=box.yourdomain.com`, `CADDY_HTTP_PORT=80`, `CADDY_HTTPS_PORT=443`).
7. `docker compose up -d --build` (this builds both portal and workspace images).
8. Caddy fetches a real Let's Encrypt cert on first request.

A Terraform module for this lives in `infra/terraform/` — to be written.
