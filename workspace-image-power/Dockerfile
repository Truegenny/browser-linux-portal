# syntax=docker/dockerfile:1.7
#
# POWER workspace image: Ubuntu 24.04 + Node 22 + KDE Plasma + the full
# Playwright browser suite (chromium/firefox/webkit) + computer-use tooling.
#
# This is a SEPARATE image from the terminal/desktop-lite image
# (workspace-image/, Debian 12). The power tier is rare, opt-in, and gets a
# larger RAM/CPU/shm allotment. We diverge to Ubuntu 24.04 deliberately:
#   * Playwright's first-class CI target is Ubuntu — `playwright install
#     --with-deps` resolves all three engines' OS deps (incl. WebKit's long
#     tail: libwoff/gstreamer/libenchant/libhyphen) cleanly here.
#   * Newer Mesa/GTK/font stack → smoother headed-browser rendering over VNC.
#   * The full (non-slim) base ships lsb-release etc., so NodeSource installs
#     cleanly — sidestepping the slim-image NodeSource failure in the Debian
#     image's history.
#
# IMPORTANT — identity convention. The portal mounts the home volume at
# /home/node and binds everything (filebrowser root, tier-switch volume
# reuse) to the `node` user at uid 1000. Ubuntu's stock uid-1000 user is
# `ubuntu` with /home/ubuntu, so we RENAME it to node + /home/node below.
# This keeps the user/home/uid identical across both images, so the SAME
# ws-<user>-home volume works whether a user is on desktop-lite (Debian) or
# power (Ubuntu) — switching tiers preserves their data.
#
# Security posture is identical to the lite image: the portal runs this with
# no-new-privileges and a dropped capability set, so Chromium/Chrome must be
# launched with --no-sandbox (its setuid/userns sandbox can't initialize).
# A real /dev/shm is provided by the portal (ShmSize, 2g for this tier), so
# do NOT use --disable-dev-shm-usage.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    # Bake Playwright browsers into the image at a system path rather than
    # the per-user ~/.cache (which lives on the home volume). This keeps the
    # ~500 MB-1 GB of browsers in the image layer, shared and immutable, and
    # means a fresh home volume already has working browsers.
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    # MUST include /usr/sbin + /sbin: usermod/groupmod (step 1) and
    # make-ssl-cert (step 4) live in /usr/sbin, and at runtime the portal
    # execs `ss` (iproute2) which can resolve via sbin. Omitting them gives
    # "usermod: not found" (exit 127) at build despite passwd being installed.
    PATH="/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# 1) Sanity print + rename the stock uid-1000 `ubuntu` user to `node` with
# home /home/node, matching the portal's volume-mount + filebrowser-root
# convention (see header). `-m` migrates the (empty) home dir.
# (usermod/groupmod come from the passwd package, which ubuntu:24.04 ships;
# they live in /usr/sbin — see the ENV PATH note above.)
RUN set -eux; \
    cat /etc/os-release; \
    uname -a; \
    usermod  -l node -d /home/node -m ubuntu; \
    groupmod -n node ubuntu; \
    id node

# 2) Core dev tools.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl wget git sudo tini \
      build-essential python3 python3-pip python3-venv \
      vim nano less jq tmux htop iproute2 procps \
      openssh-client gnupg unzip zip file man-db locales; \
    locale-gen C.UTF-8 || true; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 3) Node 22 LTS via NodeSource. The full ubuntu base has lsb-release and the
# other helpers the setup script expects, so this is reliable here.
RUN set -eux; \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    node --version; \
    npm --version

# 4) KDE Plasma desktop (X11 session over KasmVNC) + dbus + X utils.
# We install the metapackage WITH recommends — KDE is recommend-heavy and a
# curated --no-install-recommends set tends to produce a half-broken session.
# sddm (display manager) gets pulled in but is never started: there's no
# init/systemd in the container, and we launch startplasma-x11 ourselves from
# the entrypoint (same pattern the lite image uses for xfce4-session).
#
# ssl-cert provides the snakeoil cert/key KasmVNC loads on startup even in
# HTTP-only mode; without it vncserver fails at cert load and never binds.
RUN set -eux; \
    apt-get update; \
    apt-get install -y \
      kde-plasma-desktop \
      dolphin konsole kate; \
    apt-get install -y --no-install-recommends \
      dbus-x11 xauth x11-xserver-utils x11-utils xvfb \
      fonts-dejavu fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      ssl-cert; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    test -f /etc/ssl/private/ssl-cert-snakeoil.key || /usr/sbin/make-ssl-cert generate-default-snakeoil --force-overwrite; \
    chmod a+rx /etc/ssl/private; \
    chmod a+r  /etc/ssl/private/ssl-cert-snakeoil.key; \
    chmod a+r  /etc/ssl/private/ssl-cert-snakeoil.pem 2>/dev/null || true

# 5) Computer-use tooling — what a screen-driving agent (Claude cowork / the
# computer-use loop) uses to screenshot, click, type, and manage windows on
# the KasmVNC display.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      xdotool wmctrl scrot imagemagick xclip x11-apps; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 6) Google Chrome (stable) — a real Chrome for cowork in addition to the
# Playwright-managed chromium. Adds Google's apt repo + key.
RUN set -eux; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends google-chrome-stable; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    google-chrome-stable --version

# 7) ttyd + filebrowser — arch-aware downloads from upstream releases.
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
    # Pin filebrowser to v2.32.0 — see the lite image's Dockerfile for why
    # (newer 2.6x ignores --noauth/--baseURL as we use them).
    curl -fSL --retry 3 --retry-delay 2 -o /tmp/filebrowser.tar.gz \
      "https://github.com/filebrowser/filebrowser/releases/download/v2.32.0/linux-${FB_ARCH}-filebrowser.tar.gz"; \
    tar -xzf /tmp/filebrowser.tar.gz -C /usr/local/bin filebrowser; \
    chmod +x /usr/local/bin/filebrowser; \
    rm /tmp/filebrowser.tar.gz; \
    /usr/local/bin/filebrowser version

# 8) KasmVNC — use the `noble` (Ubuntu 24.04) build of the .deb. Same
# perl-dependency caveat as the lite image: the vncserver wrapper Recommends
# (not Depends) several CPAN modules that --no-install-recommends would skip,
# so we install them explicitly.
ARG KASMVNC_VERSION=1.3.3
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) KASMVNC_ARCH=amd64 ;; \
      arm64) KASMVNC_ARCH=arm64 ;; \
      *) echo "Unsupported TARGETARCH=${TARGETARCH} for KasmVNC" >&2; exit 1 ;; \
    esac; \
    curl -fSL --retry 3 --retry-delay 2 \
      -o /tmp/kasmvncserver.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_noble_${KASMVNC_VERSION}_${KASMVNC_ARCH}.deb"; \
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
    vncserver --help 2>&1 | head -5 || true; \
    perl -MDateTime -MYAML::Tiny -MTry::Tiny -MHash::Merge -e 'print "perl deps ok\n"'

# 9) Pre-build a filebrowser DB with auth disabled (mirrors the lite image).
ENV FB_DB=/usr/local/share/filebrowser/filebrowser.db
RUN set -eux; \
    mkdir -p /usr/local/share/filebrowser; \
    filebrowser config init --database "$FB_DB"
RUN set -eux; \
    filebrowser config set --auth.method=noauth --database "$FB_DB"
RUN set -eux; \
    filebrowser config set --branding.name="ClaudeLab Files" --database "$FB_DB" || \
      echo "WARN: --branding.name not accepted by this filebrowser version"; \
    filebrowser config set --branding.disableExternal=true --database "$FB_DB" || \
      echo "WARN: --branding.disableExternal not accepted by this filebrowser version"; \
    filebrowser config set --branding.theme=dark --database "$FB_DB" || \
      echo "WARN: --branding.theme not accepted by this filebrowser version"
RUN set -eux; \
    filebrowser users add nobody noauth-unused-placeholder-xxx --perm.admin --database "$FB_DB"
RUN chmod 644 "$FB_DB"

# 10) Node global tooling: Claude Code CLI + Playwright. Then download all
# three browser engines and their OS deps to PLAYWRIGHT_BROWSERS_PATH.
# `--with-deps` apt-installs the engines' shared libraries (incl. WebKit's
# long dependency tail). Browsers land in /opt/ms-playwright (system, baked).
RUN set -eux; \
    npm install -g @anthropic-ai/claude-code playwright; \
    claude --version || true; \
    npx --yes playwright install --with-deps chromium firefox webkit; \
    # World-readable so the unprivileged `node` user can launch them, and
    # the npm prefix is owned by node so claude-code's auto-updater works.
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"; \
    chown -R node:node /usr/local/lib/node_modules /usr/local/bin; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# 11) Passwordless sudo for the `node` user.
RUN set -eux; \
    printf 'node ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/node; \
    chmod 0440 /etc/sudoers.d/node

COPY motd /etc/motd
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY show-banner.sh /usr/local/bin/claudelab-banner
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/claudelab-banner

USER node
WORKDIR /home/node

# Login shell: MOTD + admin banner + one-time claude-login hint. DISPLAY=:1
# is the KasmVNC/KDE screen, so headed browsers, Playwright (headed), and
# xdotool/scrot launched from the terminal render onto the visible desktop.
RUN set -eux; \
    echo 'export DISPLAY=:1' >> /home/node/.bashrc; \
    echo 'cat /etc/motd' >> /home/node/.bashrc; \
    echo '/usr/local/bin/claudelab-banner 2>/dev/null || true' >> /home/node/.bashrc; \
    echo '[ -f /home/node/.first-run ] || { echo; echo "Tip: run \"claude /login\" to authenticate Claude Code."; echo; touch /home/node/.first-run; }' >> /home/node/.bashrc

EXPOSE 7681 7682 7683

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
