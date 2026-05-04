# syntax=docker/dockerfile:1.7
#
# Workspace image: Debian 12 slim + Node 20 + Claude Code + ttyd.
#
# We use the official `node:20-bookworm-slim` (Debian 12 slim with Node 20
# preinstalled and maintained by the Node + Docker teams) to avoid the
# NodeSource setup script that was failing on the Portainer host.
#
# Each RUN below starts with `set -eux` so every command is echoed; if a
# step fails, the exact failing command appears in the build log.

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH="/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin"

# 1) Sanity: which OS, arch, shell are we actually on?
RUN set -eux; \
    cat /etc/os-release; \
    uname -a; \
    which sh bash; \
    sh --version 2>/dev/null || true; \
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

# 3) ttyd — arch-aware download from upstream releases.
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) TTYD_ARCH=x86_64 ;; \
      arm64) TTYD_ARCH=aarch64 ;; \
      arm)   TTYD_ARCH=arm ;; \
      *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fSL --retry 3 --retry-delay 2 -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH}"; \
    chmod +x /usr/local/bin/ttyd; \
    /usr/local/bin/ttyd --version

# 4) Claude Code.
RUN set -eux; \
    npm install -g @anthropic-ai/claude-code; \
    claude --version || true

# 5) Non-root dev user with passwordless sudo.
RUN set -eux; \
    useradd -m -s /bin/bash -u 1000 dev; \
    printf 'dev ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/dev; \
    chmod 0440 /etc/sudoers.d/dev

COPY motd /etc/motd
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER dev
WORKDIR /home/dev

# Bash login shell shows MOTD and a one-time claude-login hint.
RUN set -eux; \
    echo 'cat /etc/motd' >> /home/dev/.bashrc; \
    echo '[ -f /home/dev/.first-run ] || { echo; echo "Tip: run \"claude /login\" to authenticate Claude Code."; echo; touch /home/dev/.first-run; }' >> /home/dev/.bashrc

EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
