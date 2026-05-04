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

EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
