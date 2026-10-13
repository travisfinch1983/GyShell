#!/bin/bash
# nicky-claude headless session launcher (set up by claude1, 2026-10-12).
# Started by nicky-claude-session.service inside dtach (socket /tmp/nicky-claude.sock); AI-Lab's
# Claude tab attaches to that socket over SSH. IS_SANDBOX=1 (from the unit) + onboarding flags +
# --dangerously-skip-permissions => boots straight in, no prompts.
cd /root || exit 1
python3 - <<'PY' 2>/dev/null || true
import json, os
p='/root/.claude.json'
try: d=json.load(open(p))
except Exception: d={}
d['hasCompletedOnboarding']=True
proj=d.setdefault('projects',{}).setdefault('/root',{})
proj['hasTrustDialogAccepted']=True; proj['hasCompletedProjectOnboarding']=True
json.dump(d,open(p+'.tmp','w'),indent=2); os.replace(p+'.tmp',p)
PY
CLAUDE=/root/.local/bin/claude
export PATH="/root/.bun/bin:/root/.local/bin:$PATH"
# fleet: messages to/from claude1 and the other agents (fleetd on CT152)
export FLEET_AGENT_ID=nicky-claude
export FLEETD_URL=http://10.0.0.219:17900
# Matrix channel (fork marketplace ailab-local); config in ~/.claude/channels/matrix/
COMMON=(--dangerously-load-development-channels server:fleet plugin:matrix@ailab-local --dangerously-skip-permissions)
MODE=$(cat /root/.claude-launch-mode 2>/dev/null); rm -f /root/.claude-launch-mode
if [ "$MODE" = resume ] && ls /root/.claude/projects/*/*.jsonl >/dev/null 2>&1; then
  exec "$CLAUDE" -r "${COMMON[@]}"
elif ls /root/.claude/projects/*/*.jsonl >/dev/null 2>&1; then
  "$CLAUDE" --continue "${COMMON[@]}" || exec "$CLAUDE" "${COMMON[@]}"
else
  exec "$CLAUDE" "${COMMON[@]}"
fi
