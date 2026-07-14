#!/bin/bash
# Deploy the proxlab logrotate config into the agent containers.
# Run ON each PVE host (or via ssh): ./deploy.sh <vmid>
#   px-gpu  (10.0.0.100): ./deploy.sh 177
#   px-epyc (10.0.0.101): ./deploy.sh 176
set -euo pipefail

VMID="${1:?usage: deploy.sh <vmid>}"
DIR="$(cd "$(dirname "$0")" && pwd)"

pct exec "$VMID" -- sh -c 'command -v logrotate >/dev/null' \
  || { echo "logrotate not installed in CT$VMID"; exit 1; }

pct push "$VMID" "$DIR/proxlab.logrotate" /etc/logrotate.d/proxlab --perms 0644
pct exec "$VMID" -- logrotate -d /etc/logrotate.d/proxlab >/dev/null 2>&1 \
  || { echo "config failed logrotate dry-run in CT$VMID"; exit 1; }

echo "CT$VMID: /etc/logrotate.d/proxlab deployed (logrotate.timer: $(pct exec "$VMID" -- systemctl is-enabled logrotate.timer))"
