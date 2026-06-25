# Host resize / reboot recovery runbook

What to do when the ClaudeLab VM (`claudelab-prod`, repo at `/opt/claudelab`)
comes back from an **Azure VM resize** (stop-deallocate → change size → start)
or any **full reboot**, and the site is down.

This is written from the real recovery on 2026-06-24 after a D-series resize.
Two things broke that time, both now mostly self-healing — verify, don't assume.

> TL;DR for a clean reboot: `cd /opt/claudelab && docker compose up -d`, then
> have users click **Start** on `/app`. If the site times out, jump to §3.

---

## 0. Expected post-boot state (all normal)

- **Core stack auto-starts** (`caddy`, `oauth2-proxy`, `portal` have
  `restart: unless-stopped`).
- **User workspaces are all STOPPED.** `ws-*` containers are created with
  `RestartPolicy: no` on purpose, so they never auto-start. Each user clicks
  **Start** on `/app` to bring theirs back — their `/home/node` data is intact
  on the `ws-<user>-home` volume.
- The two `*-image-builder` containers sit at **Exited (0)** — expected.

## 1. Verify the Docker data disk is mounted (the big one)

Docker's data (all images + every `ws-*-home` user volume) lives on a separate
**256 GB data disk** (`/dev/sda`, ext4), mounted at `/var/lib/docker`. The
~61 GB OS disk (`/dev/sdb1`, `/`) is NOT big enough for it.

```bash
df -h /var/lib/docker      # MUST show /dev/sda (~251G). If it shows /dev/root, the disk didn't mount.
```

This is now persisted in `/etc/fstab` so it auto-mounts on boot:
```
UUID=259663e7-7177-443d-9628-9f3641fb505e /var/lib/docker ext4 defaults,nofail,x-systemd.device-timeout=10 0 2
```

**If `/var/lib/docker` is on `/dev/root` instead of `/dev/sda`** (the disk
didn't mount — Docker then silently uses the OS disk and your volumes/images
look "missing"):

```bash
sudo systemctl stop docker docker.socket
# inspect first (read-only) to confirm it's the real data root:
sudo mkdir -p /mnt/datadisk && sudo mount -o ro /dev/sda /mnt/datadisk
sudo ls /mnt/datadisk                 # expect: image/ overlay2/ volumes/ containers/ ...
sudo ls /mnt/datadisk/volumes | grep -- -home    # expect: ws-*-home dirs
sudo umount /mnt/datadisk
# move aside whatever Docker wrote to the OS disk, then mount the real disk:
sudo mv /var/lib/docker /var/lib/docker.osdisk
sudo mkdir /var/lib/docker
sudo mount /dev/sda /var/lib/docker
sudo systemctl start docker
# verify, then reclaim the OS-disk copy ONLY after volumes/images are confirmed back:
docker volume ls | grep -- -home
sudo rm -rf /var/lib/docker.osdisk
```
(The fstab line above should make this unnecessary going forward — but check.)

⚠️ **Never** run `docker system prune --volumes` — it deletes the `ws-*-home`
user volumes.

## 2. Start the stack

```bash
cd /opt/claudelab
docker compose up -d
docker compose ps           # caddy + oauth2-proxy + portal should be Up
```

## 3. If the portal is unreachable (connection TIMES OUT)

Symptom: browser shows `ERR_CONNECTION_TIMED_OUT`; containers are `Up` and
`docker compose logs portal` shows a clean "portal up". A **timeout** (not
"refused", not a TLS error) means packets are dropped before reaching Caddy.

After a Docker daemon **stop/start** (e.g. the disk fix in §1), Docker's
**bridge/veth plumbing gets wedged**: the iptables rules look correct, but the
bridges don't actually pass traffic. A plain `systemctl restart docker` does
**not** fix it. The fix is to rebuild the networks:

```bash
docker compose down          # harmless warning "workspace-net has active endpoints" is OK
docker compose up -d
docker compose ps
```

Confirm caddy is reachable again (internal, bypassing Azure):
```bash
docker exec caddy wget -S -qO /dev/null http://127.0.0.1/ 2>&1 | head -3   # expect HTTP/1.1 308
CADDY_IP=$(docker inspect caddy -f '{{(index .NetworkSettings.Networks "portal-net").IPAddress}}')
curl -sS -o /dev/null -w "internal: %{http_code}\n" -k --resolve claudelab.ntiva.com:443:$CADDY_IP https://claudelab.ntiva.com/   # expect 302
```
Then test `https://claudelab.ntiva.com` from a real browser (outside the VM).

### Diagnosing host-vs-Azure if §3 doesn't fix it
- **`curl http://localhost` from the host is a BAD test** — with the
  userland-proxy it resets on a Host mismatch, and you can't hairpin to your own
  Azure public IP from the same VM. Always test from a real external client.
- Settle it with tcpdump while hitting the site from an external browser:
  ```bash
  sudo timeout 20 tcpdump -ni any 'tcp port 443 and tcp[tcpflags] & tcp-syn != 0'
  ```
  - SYNs appear → traffic reaches the VM → it's host networking (redo §3, check
    `sysctl net.ipv4.ip_forward` = 1, `sudo iptables -t nat -nL DOCKER`).
  - Nothing appears → Azure isn't delivering inbound → check the **NSG inbound
    rules for 80/443** and that the **public IP is still associated** with the NIC.

## 4. DNS / public IP

- DNS `claudelab.ntiva.com` must point at the VM's current public IP. Check:
  ```bash
  curl -s https://api.ipify.org; echo        # VM's public IP
  getent hosts claudelab.ntiva.com           # what DNS resolves to
  ```
- Keep the Azure public IP set to **Static** so a stop-deallocate never drifts
  it (a drift breaks both browser access and Caddy's Let's Encrypt renewal).

## 5. Tell users

Workspaces are stopped after any reboot. Users just open `/app` and click
**Start**. Nothing is lost — only the container is recreated; the home volume
persists.

---

## OS disk filling up (`/` near full)

The 61 GB OS disk (`/dev/sdb1`, `/`) is separate from the 251 GB Docker data
disk (`/dev/sda`, `/var/lib/docker`). If `/` fills up, it is almost always
**Docker build cache** in `/var/lib/containerd` — this Docker uses the
**containerd image store**, so image layers *and* build cache live under
`/var/lib/containerd` on the **OS disk**, not the data disk. Every
`docker compose build --no-cache ...` (the power image is ~8 GB) dumps a fresh
pile of build cache there.

Diagnose:
```bash
df -h /
sudo du -xh --max-depth=1 /var/lib 2>/dev/null | sort -rh | head   # expect /var/lib/containerd as the big one
docker system df                                                    # Build Cache row = the reclaimable part
```

Fix (safe — never touches volumes or running containers):
```bash
docker builder prune -af      # reclaims the build cache — the usual culprit
docker image prune -af        # dangling images (often 0B here; images retag in place)
docker container prune -f      # optional: stopped ws-*/builder containers; portal recreates on Start
df -h /
```

⚠️ Never `docker system prune --volumes` — deletes the `ws-*-home` user data.

**Habit that prevents it:** run `docker builder prune -af` after any
`--no-cache` build, and avoid `--no-cache` unless you truly need a clean build
(a cached rebuild reuses the heavy KDE/Playwright layers and adds ~nothing).
In-use images are ~28 GB and stable; only build cache grows.

(2026-06-24: `/` hit 89%; `docker builder prune -af` freed 28 GB → 51%.)
