# syntax=docker/dockerfile:1.7
#
# Workspace image: Debian 12 slim + Node 20 + Claude Code + ttyd.
#
# We use `node:20-bookworm-slim`. That image already ships a non-root
# `node` user (uid 1000, /home/node, bash shell) created during the
# upstream build, so we reuse it instead of running `useradd` ourselves.
# `useradd` isn't in the slim image's final filesystem, which was the
# cause of the previous exit-127 build failure.

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH="/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin"

# 1) Sanity print: which OS, arch, shell are we actually on?
RUN set -eux; \
    cat /etc/os-release; \
    uname -a; \
    id node; \
    node --version; \
    npm --version

# 2) Dev tools.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl wget git sudo tini \
      build-essential python3 python3-pip python3-venv \
      vim nano less jq tmux htop iproute2 procps \
      openssh-client gnupg unzip zip file man-db; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 2b) Graphical desktop stack — XFCE4 core, Xvfb (headless X), dbus, Firefox.
# Same --no-install-recommends so we skip ~50 MB of optional accessories.
# This adds ~700 MB to the image; if image size becomes a concern, the
# heaviest single dep is firefox-esr (~250 MB).
#
# `ssl-cert` provides /etc/ssl/private/ssl-cert-snakeoil.{pem,key}, which
# the KasmVNC wrapper tries to load on startup even when we configure
# HTTP-only. Without it, vncserver fails at cert load and never binds.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      xvfb dbus-x11 xauth x11-xserver-utils x11-utils \
      xfce4 xfce4-terminal thunar \
      firefox-esr \
      fonts-dejavu fonts-liberation \
      libnss-wrapper \
      ssl-cert; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    # Generate the snakeoil cert/key if not already present.
    test -f /etc/ssl/private/ssl-cert-snakeoil.key || /usr/sbin/make-ssl-cert generate-default-snakeoil --force-overwrite; \
    # Both the file AND the parent directory need to be readable by node:
    # /etc/ssl/private/ defaults to mode 0710 (root:ssl-cert), which blocks
    # traversal for anyone not in the ssl-cert group. Chmod both so the
    # file is reachable. Safe enough — it's a self-signed dev cert in a
    # sandboxed container.
    chmod a+rx /etc/ssl/private; \
    chmod a+r  /etc/ssl/private/ssl-cert-snakeoil.key; \
    chmod a+r  /etc/ssl/private/ssl-cert-snakeoil.pem 2>/dev/null || true; \
    ls -la /etc/ssl/private/

# 3) ttyd + filebrowser — arch-aware downloads from upstream releases.
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) TTYD_ARCH=x86_64; FB_ARCH=amd64 ;; \
      arm64) TTYD_ARCH=aarch64; FB_ARCH=arm64 ;; \
      arm)   TTYD_ARCH=arm;     FB_ARCH=armv7 ;; \
      *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    \
    curl -fSL --retry 3 --retry-delay 2 -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH}"; \
    chmod +x /usr/local/bin/ttyd; \
    /usr/local/bin/ttyd --version; \
    \
    # Pin filebrowser to v2.32.0. Newer 2.63.x has a rewritten SPA that
    # ignores --noauth/--baseURL CLI flags as we use them, breaks our
    # routing, and quick-bootstraps an admin user even with auth.method=
    # noauth. 2.32.0 is the last release that worked cleanly with this
    # stack. Revisit when 2.6x stabilizes or when we move to OIDC.
    curl -fSL --retry 3 --retry-delay 2 -o /tmp/filebrowser.tar.gz \
      "https://github.com/filebrowser/filebrowser/releases/download/v2.32.0/linux-${FB_ARCH}-filebrowser.tar.gz"; \
    tar -xzf /tmp/filebrowser.tar.gz -C /usr/local/bin filebrowser; \
    chmod +x /usr/local/bin/filebrowser; \
    rm /tmp/filebrowser.tar.gz; \
    /usr/local/bin/filebrowser version

# 3c) KasmVNC — modern TigerVNC fork with a built-in HTML5 web client.
# Single binary, serves both the X display and the WebSocket+HTML on one
# port, supports subpath via config (works behind our Caddy /u/<u>/desktop/
# reverse proxy). Pinned to v1.3.3; bump the version line below to upgrade.
#
# The vncserver wrapper is a Perl script that needs DateTime + a few CPAN
# modules. The .deb declares them as Recommends (not Depends), so our
# --no-install-recommends silently skipped them and the wrapper failed at
# runtime with "Can't locate DateTime.pm in @INC". We now install the
# wrapper's perl dependencies explicitly alongside the .deb.
ARG KASMVNC_VERSION=1.3.3
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) KASMVNC_ARCH=amd64 ;; \
      arm64) KASMVNC_ARCH=arm64 ;; \
      *) echo "Unsupported TARGETARCH=${TARGETARCH} for KasmVNC" >&2; exit 1 ;; \
    esac; \
    curl -fSL --retry 3 --retry-delay 2 \
      -o /tmp/kasmvncserver.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_${KASMVNC_ARCH}.deb"; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      /tmp/kasmvncserver.deb \
      libdatetime-perl \
      libyaml-tiny-perl \
      libtry-tiny-perl \
      libhash-merge-perl \
      libnet-ssleay-perl \
      libswitch-perl; \
    rm /tmp/kasmvncserver.deb; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    which vncserver Xvnc; \
    # Smoke-test the wrapper script — fails the build if any perl dep
    # is still missing.
    vncserver --help 2>&1 | head -5 || true; \
    perl -MDateTime -MYAML::Tiny -MTry::Tiny -MHash::Merge -e 'print "perl deps ok\n"'

# 3b) Pre-build a filebrowser DB with auth disabled. Each step is its own
# RUN so a failing flag fails ONE small step and the build log shows
# exactly which command rejected what.
ENV FB_DB=/usr/local/share/filebrowser/filebrowser.db

RUN set -eux; \
    mkdir -p /usr/local/share/filebrowser; \
    filebrowser config init --database "$FB_DB"

RUN set -eux; \
    filebrowser config set --auth.method=noauth --database "$FB_DB"

# Branding flags are best-effort — tolerate the failure so a renamed flag
# in a future filebrowser release doesn't break the whole build.
RUN set -eux; \
    filebrowser config set --branding.name="ClaudeLab Files" --database "$FB_DB" || \
      echo "WARN: --branding.name not accepted by this filebrowser version"; \
    filebrowser config set --branding.disableExternal=true --database "$FB_DB" || \
      echo "WARN: --branding.disableExternal not accepted by this filebrowser version"; \
    filebrowser config set --branding.theme=dark --database "$FB_DB" || \
      echo "WARN: --branding.theme not accepted by this filebrowser version"

# noauth still wants a "current user" record so request actions have an
# owner. The password is never used (auth is disabled at the proxy and via
# auth.method=noauth) but filebrowser's validator requires ≥12 chars.
RUN set -eux; \
    filebrowser users add nobody noauth-unused-placeholder-xxx --perm.admin --database "$FB_DB"

RUN chmod 644 "$FB_DB"

# 4) Claude Code.
RUN set -eux; \
    npm install -g @anthropic-ai/claude-code; \
    claude --version || true

# 5) Passwordless sudo for the existing `node` user.
RUN set -eux; \
    printf 'node ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/node; \
    chmod 0440 /etc/sudoers.d/node

COPY motd /etc/motd
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
WORKDIR /home/node

# Bash login shell shows MOTD and a one-time claude-login hint.
RUN set -eux; \
    echo 'cat /etc/motd' >> /home/node/.bashrc; \
    echo '[ -f /home/node/.first-run ] || { echo; echo "Tip: run \"claude /login\" to authenticate Claude Code."; echo; touch /home/node/.first-run; }' >> /home/node/.bashrc

EXPOSE 7681 7682 7683

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
