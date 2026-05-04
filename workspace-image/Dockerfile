FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH="/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin"

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git sudo tini \
      build-essential python3 python3-pip python3-venv \
      vim nano less jq tmux htop iproute2 procps \
      openssh-client gnupg unzip zip file man-db \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g npm@latest \
 && npm install -g @anthropic-ai/claude-code \
 && curl -fsSL -o /usr/local/bin/ttyd \
      https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 \
 && chmod +x /usr/local/bin/ttyd \
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

# Bash login shell shows MOTD and runs claude /login hint on first interactive shell
RUN echo 'cat /etc/motd' >> /home/dev/.bashrc \
 && echo '[ -f /home/dev/.first-run ] || { echo; echo "Tip: run \"claude /login\" to authenticate Claude Code."; echo; touch /home/dev/.first-run; }' >> /home/dev/.bashrc

EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
