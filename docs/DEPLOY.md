# Deploying on a clean Ubuntu VM (Azure)

This is the **recommended** way to run Browser Linux Portal. Direct Docker on
a Linux host, no Portainer in between.

Tested on Ubuntu 22.04 and 24.04 LTS, single VM, x86_64.

---

## 0. What you need before starting

- An **Ubuntu 22.04 / 24.04** Azure VM you can SSH into as a sudo user
- A **GitHub Personal Access Token** (PAT) with `repo` scope so the VM can clone
  this private repo. Create one at https://github.com/settings/tokens (classic),
  scope `repo`. Save it somewhere safe — you'll paste it once.
- Optional but nice for production: a **DNS A record** (e.g.
  `box.yourdomain.com`) pointing at the VM's public IP. If you don't have one,
  you can run on the public IP with self-signed TLS, or HTTP-only on a custom
  port.

VM sizing rule of thumb:
- 2 vCPU / 8 GB RAM is enough to play with (Standard_B2ms / D2s_v5).
- 4 vCPU / 16 GB once two or three workspaces run concurrently (B4ms / D4s_v5).
- 64 GB OS disk, plus a 128 GB Premium SSD data disk mounted at
  `/var/lib/docker` if you expect heavy use (workspace volumes live there).

---

## 1. SSH in and update the system

```bash
ssh azureuser@<public-ip>          # or `az ssh vm ...`

sudo apt-get update
sudo apt-get -y upgrade
sudo apt-get -y install ca-certificates curl gnupg git ufw
```

(Reboot if `apt-get upgrade` updated the kernel: `sudo reboot`, reconnect.)

---

## 2. Install Docker Engine + Compose plugin

This is Docker's official one-liner for Ubuntu:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

That installs Docker Engine, containerd, and the Docker Compose plugin
(`docker compose ...`).

Add yourself to the `docker` group so you don't need sudo:

```bash
sudo usermod -aG docker $USER
newgrp docker          # re-evaluate group membership in current shell
docker version         # should print client + server, no permission errors
docker compose version # should print "Docker Compose version v2.x.x"
```

If `docker compose version` is older than `v2.20.0`, upgrade it (see
Troubleshooting at the bottom). Older versions don't support `pull_policy: build`
which the stack relies on.

---

## 3. Clone the repo

Because this repo is private, the VM needs credentials. Easiest is a one-time
HTTPS clone with your PAT in the URL — Git will discard it after the clone:

```bash
sudo mkdir -p /opt/blp
sudo chown $USER:$USER /opt/blp
cd /opt/blp

# Replace ghp_xxx with your PAT
git clone https://Truegenny:ghp_xxxxxxxxxxxxxxxxxxxx@github.com/Truegenny/browser-linux-portal.git .
```

If you'd rather not embed the token, install `gh` and `gh auth login` once:

```bash
sudo apt-get install -y gh   # may not be in default repos; see https://cli.github.com/
gh auth login                # follow the browser device-code flow
gh repo clone Truegenny/browser-linux-portal /opt/blp
cd /opt/blp
```

Either way, you should now have `/opt/blp/docker-compose.yml` and friends.

---

## 4. Set up SSO in Entra ID

**Do this first** — the redirect URI requires the FQDN, which means DNS
needs to point at the VM. Once DNS is live, follow [SSO.md](./SSO.md)
end-to-end. You'll come back with these values in hand:

- `OIDC_TENANT_ID`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `ADMIN_GROUP_OID`
- `OAUTH2_PROXY_COOKIE_SECRET` (`openssl rand -base64 32`)

---

## 5. Configure environment

```bash
cd /opt/blp
cp .env.example .env
nano .env
```

Fill in:

```
SITE_ADDRESS=workspaces.yourdomain.com
ACME_EMAIL=you@yourdomain.com
CADDY_HTTP_PORT=80
CADDY_HTTPS_PORT=443

# From step 4 (Entra app registration)
OIDC_TENANT_ID=…
OIDC_CLIENT_ID=…
OIDC_CLIENT_SECRET=…
OAUTH2_PROXY_COOKIE_SECRET=…
OAUTH2_PROXY_EMAIL_DOMAINS=yourdomain.com

# Admin signal
ADMIN_GROUP_OID=…
ADMIN_USERS=you@yourdomain.com

# Workspace defaults
WORKSPACE_MEMORY_TERMINAL=2g
WORKSPACE_MEMORY_DESKTOP=3g
WORKSPACE_CPUS=1.5
WORKSPACE_IDLE_HOURS=2
```

`SITE_ADDRESS` is Caddy's site label AND oauth2-proxy's cookie domain.
Caddy will automatically obtain a Let's Encrypt cert on first request
as long as the DNS A record points at this VM and ports 80 + 443 are
reachable from the internet.

There is no first-test mode on `:80` — SSO requires HTTPS. If you need
a non-production sandbox, deploy under a `dev.` subdomain with the same
Let's Encrypt cert flow.

---

## 6. Build and start

```bash
docker compose up -d --build
```

First run is slow — the workspace image is ~1.2 GB (Debian + Node 20 +
Claude Code + ttyd). 5–10 minutes on a B2ms.

When it finishes:

```bash
docker compose ps
```

You should see:
- `caddy` — running
- `portal` — running
- `workspace-image-builder` — Exited (0)  ← expected; one-shot build container

---

## 7. Open Azure NSG

In the Azure Portal: **VM → Networking → Inbound port rules → Add**.

For the first-test config (`CADDY_HTTP_PORT=8080`):

- Port: **8080** TCP
- Source: **My IP** (replace with `Any` once you trust it works)

For production (real DNS + ports 80/443):

- Port **80** TCP, source `Any` (Let's Encrypt HTTP-01 challenge)
- Port **443** TCP, source `Any`

Keep port **22** restricted to your IP. Don't open the Docker socket or
Postgres ports to the internet.

---

## 8. First test

In your local browser, hit:

- **First-test config:** `http://<vm-public-ip>:8080/`
- **Production config:** `https://box.yourdomain.com/`

You should see the dark-themed marketing landing page. Click **Sign in**.
Browser will prompt for basicauth — enter `admin` and the password from step 5.

Click **Create my workspace** → wait a few seconds → **Open terminal**.
A new tab opens with bash inside your container.

```
$ claude /login        # one-time OAuth, stores token in ~/.claude/
$ claude               # start a chat
```

`/home/node/` persists across container restarts (it's a Docker named volume).

---

## 9. Run as a service (optional, but recommended)

Make Docker Compose start the stack on boot:

```bash
sudo tee /etc/systemd/system/browser-linux-portal.service >/dev/null <<'EOF'
[Unit]
Description=Browser Linux Portal stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/blp
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now browser-linux-portal
```

Now `sudo systemctl status browser-linux-portal` shows the stack and it
restarts on reboot.

---

## 10. Idle reaper (optional)

Stops user containers idle > `WORKSPACE_IDLE_HOURS` from `.env`:

```bash
( crontab -l 2>/dev/null; echo "*/15 * * * * /opt/blp/scripts/idle-stop.sh >> /var/log/browser-linux-idle.log 2>&1" ) | crontab -
```

---

## 11. Updating the deployment

When you push commits to `main`:

```bash
cd /opt/blp
git pull
docker compose up -d --build
```

If you've changed `workspace-image/Dockerfile` and want existing user
containers to pick up the new image, ask them to log into `/admin` (if
they're admin) or have an admin go to `/admin` and click **Destroy** on
their row. The volume is preserved by default; the next "Create my
workspace" pulls them onto the new image with their `/home/node` intact.

---

## 12. Backups

User home volumes are named `ws-<user>-home`. Back them up:

```bash
mkdir -p /opt/blp/backups
for vol in $(docker volume ls -q --filter name='^ws-.*-home$'); do
  docker run --rm \
    -v "$vol:/data:ro" \
    -v "/opt/blp/backups:/out" \
    alpine tar czf "/out/${vol}-$(date -u +%F).tgz" -C /data .
done
```

Schedule via cron, push to Azure Blob with `azcopy`.

---

## Troubleshooting

### `docker compose version` is older than 2.20

The Docker get-docker script normally pulls the latest. If you ended up with
an older version (e.g., from `apt install docker-compose` instead of the
plugin):

```bash
sudo apt-get remove -y docker-compose
sudo apt-get install -y docker-compose-plugin
docker compose version   # confirm 2.x
```

### Caddy can't get a Let's Encrypt cert

- DNS A record must resolve to the VM's public IP (`dig +short box.yourdomain.com`).
- Ports 80 and 443 must be reachable from the internet (NSG + ufw).
- The first request takes a few seconds while ACME completes.
- Logs: `docker compose logs caddy`.

### "Workspace stuck in 'absent' / 'creating'"

Check the portal log:
```bash
docker compose logs portal
```
Common causes: workspace image not built (run `docker images | grep workspace`),
or Docker socket permission (the portal mounts `/var/run/docker.sock`; the
docker daemon must own it as the docker group).

### Resetting everything

```bash
cd /opt/blp
docker compose down -v          # removes containers AND volumes (data loss!)
docker volume ls -q | grep '^ws-' | xargs -r docker volume rm
docker rmi browser-linux-workspace:latest 2>/dev/null
docker compose up -d --build
```

### Can't reach the site from your laptop

- `curl -I http://<vm-public-ip>:8080/` from the VM itself — should return 200.
  If it doesn't, the stack isn't healthy.
- If the local curl works but external doesn't: NSG rule, ufw, or Azure-side
  firewall.
- `sudo ufw status` — ensure the port is allowed if ufw is enabled.

```bash
sudo ufw allow 8080/tcp     # or 80, 443
sudo ufw reload
```
