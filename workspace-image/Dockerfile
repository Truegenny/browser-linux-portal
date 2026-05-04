# Workspace image: Debian 12 slim + Node 20 + Claude Code + ttyd.
#
# We use the official `node:20-bookworm-slim` (Debian 12 slim with Node 20
# preinstalled and maintained by the Node + Docker teams) instead of running
# NodeSource's setup script ourselves — that script depends on a few utilities
# missing from a bare `debian:12-slim` and was failing the build with exit 127.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH="/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin"

# Detect target architecture so the ttyd download works on both amd64 and
# arm64 Portainer hosts (BuildKit provides $TARGETARCH automatically).
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git sudo tini \
      build-essential python3 python3-pip python3-venv \
      vim nano less jq tmux htop iproute2 procps \
      openssh-client gnupg unzip zip file man-db \
 && case "${TARGETARCH:-amd64}" in \
      amd64) TTYD_ARCH=x86_64 ;; \
      arm64) TTYD_ARCH=aarch64 ;; \
      arm)   TTYD_ARCH=arm ;; \
      *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH}" \
 && chmod +x /usr/local/bin/ttyd \
 && /usr/local/bin/ttyd --version \
 && npm install -g @anthropic-ai/claude-code \
 && useradd -m -s /bin/bash -u 1000 dev \
 && echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev \
 && chmod 0440 /etc/sudoers.d/dev \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY motd /etc/motd
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER dev
WORKDIR /home/dev

# Bash login shell shows MOTD and a one-time claude-login hint.
RUN echo 'cat /etc/motd' >> /home/dev/.bashrc \
 && echo '[ -f /home/dev/.first-run ] || { echo; echo "Tip: run \"claude /login\" to authenticate Claude Code."; echo; touch /home/dev/.first-run; }' >> /home/dev/.bashrc

EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
