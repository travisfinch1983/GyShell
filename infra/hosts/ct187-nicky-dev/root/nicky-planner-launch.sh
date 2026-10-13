#!/bin/bash
# nicky-planner: second Claude Code instance on CT187, on Fable, acting as planner/advisor for
# nicky-claude (set up by claude1, 2026-10-12). Own config dir so its login/refresh lineage never
# collides with nicky-claude's. Reached over fleet only (no Matrix). Same dtach pattern as nicky-claude.
cd /root/planner || exit 1
export CLAUDE_CONFIG_DIR=/root/.claude-planner
python3 - <<'PY' 2>/dev/null || true
import json, os
p='/root/.claude-planner/.claude.json'
try: d=json.load(open(p))
except Exception: d={}
d['hasCompletedOnboarding']=True
proj=d.setdefault('projects',{}).setdefault('/root/planner',{})
proj['hasTrustDialogAccepted']=True; proj['hasCompletedProjectOnboarding']=True
proj['enabledMcpjsonServers']=['fleet']
json.dump(d,open(p+'.tmp','w'),indent=2); os.replace(p+'.tmp',p)
PY
CLAUDE=/root/.local/bin/claude
export PATH="/root/.bun/bin:/root/.local/bin:$PATH"
export FLEET_AGENT_ID=nicky-planner
export FLEETD_URL=http://10.0.0.219:17900
COMMON=(--model claude-fable-5-1 --dangerously-load-development-channels server:fleet --dangerously-skip-permissions)
if ls /root/.claude-planner/projects/*/*.jsonl >/dev/null 2>&1; then
  "$CLAUDE" --continue "${COMMON[@]}" || exec "$CLAUDE" "${COMMON[@]}"
else
  exec "$CLAUDE" "${COMMON[@]}"
fi
