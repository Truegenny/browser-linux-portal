# ClaudeLab

Self-hosted dev workspace platform. Each user gets a real Debian Linux
container in their browser — terminal, files, optional XFCE/Firefox
desktop — with the Claude Code CLI preinstalled. Authentication is
Microsoft Entra ID SSO. A small alternative to Coder / GitHub
Codespaces / WebVM, sized for a team rather than a fleet.

**Production:** https://claudelab.ntiva.com (Ntiva-internal)

> The GitHub repo is still named `browser-linux-portal` — the project
> was renamed to ClaudeLab post-v1.0 and the repo rename is pending.
> Clone URLs in this README and the docs still point at the old name
> and keep working.

## What's in the box

- **Per-user containers** spawned on first sign-in. Container name
  `ws-<slug>` where `<slug>` is the lowercase local-part of the user's
  Entra email (`justin.cronin@ntiva.com` → `ws-justin.cronin`). Home
  directory persists in a named Docker volume across restarts.
- **Two tiers**, admin-toggleable per user:
  - `terminal` (2 GB RAM) — ttyd browser shell + filebrowser.
  - `desktop` (3 GB RAM) — adds KasmVNC + XFCE4 + Firefox-ESR.
- **Webapp proxy** — anything bound to `0.0.0.0:<port>` inside your
  workspace is reachable at `/u/<you>/p/<port>/`. WebSockets, SSE,
  HTTP/2 all work.
- **Entra ID SSO** via oauth2-proxy. MFA inherits from your tenant
  policy. Admin status comes from membership in a configured Entra
  security group.
- **Admin tooling** — cross-user terminal access, per-container log
  tail, listening-ports inventory, tier toggles.

## Architecture

```
  Browser (HTTPS)
       │
       ▼
┌──────────────────┐   forward_auth   ┌────────────────┐
│      Caddy       │ ───────────────▶ │  oauth2-proxy  │ ──▶ Entra ID
│  (TLS, routing)  │ ◀── headers ──── │  (OIDC + sess) │
└────────┬─────────┘
         │  copies X-Auth-Request-{Email,Groups} onto inbound request
         │  derives slug = lowercase local-part of email
         │
         ├── portal-net ───▶ portal      (Fastify/TS; dashboard, admin UI)
         │
         └── workspace-net ─▶ ws-<slug>  (per-user Debian container)
               ├ :7681  ttyd (terminal)
               ├ :7682  filebrowser
               ├ :7683  KasmVNC + XFCE (desktop tier only)
               └ :<any> user webapps
```

Caddy is on both networks; the portal is deliberately NOT on
`workspace-net` so a compromised workspace cannot reach `portal:3000`
to forge auth headers. Read [CLAUDE.md](CLAUDE.md) for the full
convention list before changing any of this.

## Deploying

Three docs cover everything:

- **[`docs/DEPLOY.md`](docs/DEPLOY.md)** — production runbook (Ubuntu
  VM, Docker, systemd, Let's Encrypt, idle reaper, backups).
- **[`docs/SSO.md`](docs/SSO.md)** — one-time Entra tenant setup (app
  registration, client secret, groups claim, admin group, common
  pitfalls).
- **[`CLAUDE.md`](CLAUDE.md)** — architecture decisions and "do not
  break these" conventions. Read before editing the Caddyfile,
  workspace image, or auth code.

Short version, assuming you've already done the Entra setup in
[`docs/SSO.md`](docs/SSO.md):

```bash
ssh azureuser@<vm-ip>
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

sudo mkdir -p /opt/claudelab && sudo chown $USER:$USER /opt/claudelab
git clone https://github.com/Truegenny/browser-linux-portal.git /opt/claudelab
cd /opt/claudelab

cp .env.example .env
nano .env   # SITE_ADDRESS, OIDC_*, ADMIN_GROUP_OID, cookie secret

docker compose up -d --build
docker compose logs -f oauth2-proxy   # watch for "OIDC: discovered issuer"
```

Then point a DNS A record at the VM and visit `https://claudelab.ntiva.com`.

## Day-to-day ops

### Granting and revoking access

Identity is owned by Entra ID. There is no local user DB; ClaudeLab
has no add-user CLI.

- **Grant:** Entra admin → *Enterprise applications → ClaudeLab → Users
  and groups* → assign the user (or a group). They sign in via `/app`,
  click **Create my workspace**, done.
- **Promote to admin:** add the user to the Entra security group
  configured as `ADMIN_GROUP_OID`. Takes effect on their next page
  load — no portal restart needed.
- **Revoke:** unassign from the Entra app. Their container is
  preserved until you destroy it explicitly (`/admin` → Destroy →
  optionally check "wipe data" to drop the home volume).

### Tier management (`/admin/users`)

New users default to `terminal` (2 GB, no GUI). Toggle to `desktop`
(3 GB, KasmVNC + XFCE) per user. Tier changes are **lazy** — the
running container keeps its current tier until the user stops + starts
it, at which point the portal destroys + recreates the container with
the new memory cap and `ENABLE_DESKTOP` env. Home volume is preserved.

### Admin tooling

| Path | What it does |
|---|---|
| `/admin` | All workspaces with live CPU/Mem, Start/Stop/Destroy, per-row Logs + Terminal links |
| `/admin/users` | Tier toggles (Enable / Disable desktop) |
| `/admin/ports` | Every listening TCP port across every running workspace, flags loopback binds |
| `/admin/logs` | Tail of Caddy's JSON access log |
| `/admin/logs/<user>` | `docker logs ws-<user>` tail (configurable `?tail=N`) |
| `/admin/term/<user>/` | Opens ttyd inside the target user's container (admin shell-replacement) |

The admin terminal shares the target's PTY with the user — useful for
remote-support shoulder-surfing, surprising otherwise.

### Backups

User data lives in named volumes `ws-<slug>-home`. Snapshot them all:

```bash
mkdir -p backups
for vol in $(docker volume ls -q --filter name='^ws-.*-home$'); do
  docker run --rm -v "$vol:/data:ro" -v "$PWD/backups:/out" alpine \
    tar czf "/out/${vol}-$(date -u +%F).tgz" -C /data .
done
```

Schedule via host cron. Push the tarballs to Azure Blob with `azcopy`
or to S3 if you want offsite copies.

### Idle reaper

Workspaces with no proxy traffic for `WORKSPACE_IDLE_HOURS` get
stopped — not destroyed. Home volumes stay; users can restart from
`/app`. Wire it up via host cron:

```cron
*/15 * * * *  /opt/claudelab/scripts/idle-stop.sh >> /var/log/claudelab-idle.log 2>&1
```

### Operational logs

```bash
docker compose logs -f portal
docker compose logs -f oauth2-proxy
docker compose logs -f caddy
docker compose exec caddy tail -f /var/log/caddy/access.log
```

### Updating

```bash
cd /opt/claudelab
git pull
docker compose up -d --build
```

The workspace image rebuilds in place; existing user containers
continue running on the *old* image until they're destroyed and
recreated. Admin → Destroy from `/admin`, user clicks Create on
`/app`, fresh container on the new image. Home volume survives.

## Security model

- **Entra ID owns identity.** No local password store. MFA inherits
  from your tenant policy.
- **Admin via Entra group**, not a flag the portal manages. Object ID
  configured in `ADMIN_GROUP_OID`. Demoting a user is a click in Entra.
- **Network split** — `portal-net` (control plane: Caddy ↔ portal) is
  isolated from `workspace-net` (data plane: Caddy ↔ ws-\*). A
  compromised workspace cannot reach `portal:3000` to forge headers.
- **CSRF** — the portal's `onRequest` hook rejects state-changing
  cross-origin requests via `Sec-Fetch-Site` (with `Origin` fallback).
  Defence in depth alongside oauth2-proxy's SameSite=Lax cookie.
- **Workspace containers** drop all Linux capabilities and re-add only
  what a dev shell with sudo needs (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`,
  `FSETID`, `KILL`, `SETUID`, `SETGID`). `no-new-privileges`,
  `PidsLimit`, per-tier memory caps, CPU cap.
- **Caveat: containers are not VMs.** Kernel-bypass attacks are out
  of scope; trust the people you grant the Entra app to.
- **Docker socket** is mounted into the portal — the portal is
  effectively root on the host. It's never published; only Caddy is.

## Project layout

```
claudelab/
├── caddy/
│   ├── Caddyfile             # routing + forward_auth + slug derivation
│   └── desktop.users.example # plain template; live file is gitignored
├── portal/                   # Fastify + TypeScript web app
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── server.ts         # routes
│       ├── lib/
│       │   ├── auth.ts       # reads X-Auth-User / X-Auth-Groups
│       │   ├── config.ts     # env loader (incl. ADMIN_GROUP_OID)
│       │   ├── csrf.ts       # onRequest CSRF guard
│       │   ├── dockerctl.ts  # container lifecycle, logs, ports, stats
│       │   ├── html.ts       # layout helper
│       │   └── users.ts      # slug derivation + desktop.users helpers
│       └── views/
│           ├── marketing.ts  # public landing page
│           ├── dashboard.ts  # /app — per-user dashboard
│           └── admin.ts      # /admin — workspaces, users, ports, logs
├── workspace-image/          # per-user container image
│   ├── Dockerfile            # Debian 12 + Node 20 + Claude Code + ttyd + filebrowser + KasmVNC
│   ├── entrypoint.sh         # ENABLE_DESKTOP gates the X server
│   └── motd
├── scripts/
│   ├── build-workspace-image.sh
│   └── idle-stop.sh
├── docs/
│   ├── DEPLOY.md             # production deploy runbook (authoritative)
│   └── SSO.md                # Entra tenant setup walkthrough
├── docker-compose.yml        # caddy + oauth2-proxy + portal + workspace-image
├── .env.example
├── CLAUDE.md                 # architecture conventions (read before editing)
└── README.md                 # ← this file
```

## Roadmap

| Version | Goal | Status |
|---|---|---|
| v0.7 | Filebrowser embedded, dark mode | ✅ |
| v0.8 | Workspace template variants | partial |
| v0.9 | XFCE4 GUI tier; admin cross-user terminal + logs | ✅ |
| **v1.0 (current)** | Entra ID SSO; basic-auth retired; first production deploy | ✅ |
| v2.0 | Per-user Anthropic API key storage (encrypted, libsodium); audit log to Postgres | planned |
| v2.5 | Workspace sharing (invite links); public file viewer for `~/public`; snapshot/clone | planned |

## License

Internal to Ntiva. All rights reserved unless specified otherwise.
