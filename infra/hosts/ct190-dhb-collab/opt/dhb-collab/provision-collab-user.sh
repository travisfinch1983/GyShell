#!/bin/bash
# provision-collab-user.sh <username> "<ssh public key>"  — CT190 dhb-collab. claude1, 2026-11-03.
# Creates the coworker's login and wires his Claude Code into the lab pieces built for it:
# fleet (via dhb-collab-gate, pinned to claude-dhb-collab), memory server #2, dhb-docs, and the
# memory prefetch/extract/transcript-archive hooks. Idempotent: re-running refreshes the config.
set -euo pipefail
U="${1:?username}"; KEY="${2:?ssh public key}"
[[ "$U" =~ ^[a-z][a-z0-9_-]{1,30}$ ]] || { echo "bad username"; exit 1; }
[[ "$KEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)\  ]] || { echo "that does not look like an SSH public key"; exit 1; }
H="/home/$U"
GATE=http://10.0.0.219:8098
MEM=http://10.0.0.219:9857/mcp

id "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash -G sshusers "$U"
usermod -aG sshusers "$U"
passwd -l "$U" >/dev/null                      # no password: key login only
echo "$U ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$U"; chmod 440 "/etc/sudoers.d/90-$U"; visudo -cq
install -d -m 700 -o "$U" -g "$U" "$H/.ssh"
grep -qxF "$KEY" "$H/.ssh/authorized_keys" 2>/dev/null || echo "$KEY" >> "$H/.ssh/authorized_keys"
chown "$U:$U" "$H/.ssh/authorized_keys"; chmod 600 "$H/.ssh/authorized_keys"

# Claude Code (native installer, per user)
if [ ! -x "$H/.local/bin/claude" ]; then
  sudo -u "$U" -H bash -c 'curl -fsSL https://claude.ai/install.sh | bash' | tail -2
fi
grep -q '.local/bin' "$H/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$H/.bashrc"

install -d -o "$U" -g "$U" "$H/.claude"
install -m 644 -o "$U" -g "$U" /opt/dhb-collab/CLAUDE.md "$H/.claude/CLAUDE.md"

# settings.json: merge (keep anything he has set himself), then (re)write our env + hooks
sudo -u "$U" -H python3 - "$H/.claude/settings.json" <<'EOF'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p)) if os.path.exists(p) else {}
d.setdefault("env", {}).update({
    "CLAUDE_INSTANCE_ID": "claude-dhb-collab",
    "CLAUDE_MEMORY_MCP": "http://10.0.0.219:9857/mcp",
    "CLAUDE_MEMORY_USER": "dhb-collab",
    "CLAUDE_EXTRACT_LLM_URL": "http://10.0.0.219:8098/api/proxy/llm/v1/chat/completions",
    "CLAUDE_EXTRACT_MODEL": "Qwen3.5-9B-INT8-MM-Thinking-Non_preserved-256k",
    "FLEET_AGENT_ID": "claude-dhb-collab",
    "FLEETD_URL": "http://10.0.0.219:8098/fleet",
})
hk = lambda c, t=None: {"type": "command", "command": c, **({"timeout": t} if t else {})}
ours = {
    "UserPromptSubmit": [{"hooks": [hk("python3 /opt/claude-hooks/claude-memory-prefetch.py", 12),
                                    hk("python3 /opt/fleet-channel/adapters/fleet-heartbeat.py")]}],
    "Stop": [{"hooks": [hk("python3 /opt/claude-hooks/claude-transcript-archive.py", 20),
                        hk("python3 /opt/claude-hooks/claude-memory-extract.py", 10),
                        hk("python3 /opt/fleet-channel/adapters/fleet-heartbeat.py")]}],
    "PreCompact": [{"hooks": [hk("python3 /opt/claude-hooks/claude-memory-extract.py", 10)]}],
}
hooks = d.setdefault("hooks", {})
for ev, groups in ours.items():
    mine = {h["command"] for g in groups for h in g["hooks"]}
    kept = [g for g in hooks.get(ev, []) if not any(h.get("command") in mine for h in g.get("hooks", []))]
    hooks[ev] = kept + groups
json.dump(d, open(p, "w"), indent=2)
EOF

# MCP servers (user scope -> ~/.claude.json)
C="$H/.local/bin/claude"
for s in fleet memory dhb-docs; do sudo -u "$U" -H "$C" mcp remove --scope user "$s" >/dev/null 2>&1 || true; done
sudo -u "$U" -H "$C" mcp add --scope user fleet -e FLEET_AGENT_ID=claude-dhb-collab -e FLEETD_URL=$GATE/fleet -- bun run /opt/fleet-channel/adapters/cc_channel.ts
sudo -u "$U" -H "$C" mcp add --scope user --transport http memory $MEM
sudo -u "$U" -H "$C" mcp add --scope user dhb-docs -e PROXLAB_URL=$GATE -e DOCRAG_ALLOW_PREFIX=docs_dhb_ -e DOCRAG_READONLY=1 -e DOCRAG_PUBLIC_URL=$GATE -- node /opt/dhb-docs/server.mjs
echo "provisioned $U"
