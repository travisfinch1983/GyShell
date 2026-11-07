#!/bin/bash
# Runs inside CT172. Installs the Blender MCP service. Keeps an existing token.
set -eu
[ "$(hostname)" = "blender" ] || { echo "wrong host"; exit 2; }
cd /opt/blender-tools
[ -d venv ] || python3 -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q 'mcp>=1.12,<2' uvicorn pillow
venv/bin/pip list 2>/dev/null | grep -E '^(mcp|uvicorn|pillow) ' -i
if [ ! -f /etc/blender-mcp.env ]; then
  umask 077
  printf 'BLENDER_MCP_TOKEN=%s\nBLENDER_MCP_ALLOW_IPS=10.0.0.161\nBLENDER_MCP_ALLOW_SCRIPT=1\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > /etc/blender-mcp.env
fi
chmod 600 /etc/blender-mcp.env
cat > /etc/systemd/system/blender-mcp.service <<'EOF'
[Unit]
Description=Blender MCP server
After=network-online.target

[Service]
EnvironmentFile=/etc/blender-mcp.env
ExecStart=/opt/blender-tools/venv/bin/python /opt/blender-tools/blender_mcp.py
Restart=on-failure
RestartSec=5
WorkingDirectory=/blender

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable blender-mcp >/dev/null 2>&1
systemctl restart blender-mcp
echo MCP_INSTALL_OK
