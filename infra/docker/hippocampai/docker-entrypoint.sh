#!/bin/sh
# Derive LLM_MODEL from AI-Lab's Support Models file so the model is controlled in ONE place
# (the Support Models tab, role `memory_extraction`) instead of being hardcoded in .env.
#
# WHY THIS EXISTS: hippo's LLM_MODEL was pinned in .env and invisible to the UI. When the
# served model name on :5020 was corrected (Qwen3.6->Qwen3.5 typo) hippo silently broke —
# nothing in the UI showed it, and a host-side grep for the old name missed it entirely
# because it lived in a container env var.
#
# PRECEDENCE: file wins, env is the fallback. A missing/!unreadable file must NOT wipe a
# working config — we keep whatever .env supplied and say so loudly.
#
# NOTE: /ai-lab-data is the bind-mounted DIRECTORY, never the file. AI-Lab writes the JSON
# atomically (tmp + rename), which swaps the inode — a file bind-mount would pin the OLD
# inode forever and this would read a stale value with no sign anything was wrong.
set -e

SM=/ai-lab-data/hermes-support-models.json
ROLE=memory_extraction

if [ -f "$SM" ]; then
  FROM_FILE="$(python3 - "$SM" "$ROLE" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as e:
    print("", file=sys.stderr); print(f"support-models unreadable: {e}", file=sys.stderr); print(""); raise SystemExit(0)
print(((cfg.get(sys.argv[2]) or {}).get("model") or ""))
PY
)"
  if [ -n "$FROM_FILE" ]; then
    if [ "$FROM_FILE" != "${LLM_MODEL:-}" ]; then
      echo "hippocampai: LLM_MODEL <- support-models[$ROLE] = '$FROM_FILE' (was '${LLM_MODEL:-unset}')"
    else
      echo "hippocampai: LLM_MODEL = '$FROM_FILE' (support-models and env agree)"
    fi
    LLM_MODEL="$FROM_FILE"
    export LLM_MODEL
  else
    echo "hippocampai: support-models has no '$ROLE' model; keeping env LLM_MODEL='${LLM_MODEL:-unset}'" >&2
  fi
else
  echo "hippocampai: $SM not mounted; keeping env LLM_MODEL='${LLM_MODEL:-unset}'" >&2
fi

exec "$@"
