#!/bin/bash
# nicky-dev base system (claude1, 2026-10-12). Idempotent; log: /root/bootstrap.log
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "== $(date) start"
timedatectl set-timezone America/Phoenix 2>/dev/null || ln -sf /usr/share/zoneinfo/America/Phoenix /etc/localtime
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl gnupg git jq unzip zip build-essential pkg-config dtach tmux htop ncdu rsync \
  python3 python3-venv python3-pip pipx python3-dev postgresql-client redis-tools sqlite3 ripgrep fd-find less nano vim locales
locale-gen en_US.UTF-8 >/dev/null
# Docker CE + compose plugin
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get update -q
apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin nodejs
systemctl enable --now docker
docker run --rm hello-world | grep -q "Hello from Docker" && echo "docker OK"
# Bun (the Matrix channel plugin runs on bun)
curl -fsSL https://bun.sh/install | bash
ln -sf /root/.bun/bin/bun /usr/local/bin/bun
# ttyd (terminal viewer for AI-Lab)
curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64
chmod +x /usr/local/bin/ttyd
# Claude Code (native installer)
curl -fsSL https://claude.ai/install.sh | bash
ln -sf /root/.local/bin/claude /usr/local/bin/claude
claude --version
node --version; docker --version; docker compose version; bun --version; ttyd --version
echo "== $(date) done"
