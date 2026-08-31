#!/usr/bin/env bash
# Provider-script drift check → notification. Run by provider-drift-check.timer.
#
# 🛑 WHY: deploy.sh --check is the ONLY thing that can catch installer drift,
# and it had no schedule — drift meant a reinstall silently DOWNGRADED a
# provider (documented: proxlab-tts.sh embedded 374 lines vs 461 running).
# A check that exists but never runs is the sweep's oldest shape.
#
# One event PER DRIFTED SCRIPT (never "N scripts drifted" — the count changes
# as scripts are fixed, and the one still drifted next pass must not read as
# first-of-kind). Every event NAMES THE HOST it ran on: this estate spent part
# of a night on an emitter aimed at a container that no longer exists, and
# "drift detected" without a location is the same shape.
#
# Silent when clean — a timer that reports success teaches people to stop
# reading. Failures of the CHECK itself (missing repo, missing dest) emit too:
# a check that cannot run must not look like a check that passed.
set -u

HOSTNAME_TAG="$(hostname)"
AILAB_API="${AILAB_API_URL:-http://10.0.0.219:17890}"
REPO_DIR="${AILAB_PROVIDER_REPO:-/root/repos/ai-lab/infra/provider-scripts}"
DEST="${AILAB_DATA_DIR:-/opt/ai-lab/.gybackend-data}/scripts/providers"

emit() { # severity message detail
  local body
  body=$(python3 - "$1" "$2" "$3" <<'PYEOF'
import json, sys
print(json.dumps({"severity": sys.argv[1], "source": "provider-scripts",
                  "message": sys.argv[2], "detail": sys.argv[3]}))
PYEOF
  )
  curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d "$body" "$AILAB_API/api/notifications/emit" >/dev/null \
    || echo "NOTIFY LOST: $1: $2" >&2
}

if [ ! -d "$REPO_DIR" ]; then
  emit warning "Provider drift check could not run" \
    "[host $HOSTNAME_TAG] repo dir absent at $REPO_DIR — the check is NOT running, which is not the same as passing. Fix AILAB_PROVIDER_REPO in the unit."
  exit 1
fi
if [ ! -d "$DEST" ]; then
  emit warning "Provider drift check could not run" \
    "[host $HOSTNAME_TAG] deployed dir absent at $DEST — nothing to compare against."
  exit 1
fi

# COLLECT findings first, decide how to report second. On 2026-08-31 a wrong
# AILAB_PROVIDER_REPO made every path map wrong in both directions and the
# per-script loop emitted 66 live warnings from one config bug (dedup
# collapsed them to two event classes, but a 66-item non-incident is still
# noise). A run where most scripts "drifted" is far more likely a
# misconfigured check than a real mass drift — so past the gate below, one
# accurate warning replaces the flood. (maintenance-claude's suggestion.)
drifted=0
total=0
findings_msg=()
findings_detail=()
finding() {
  drifted=$((drifted + 1))
  findings_msg+=("$1")
  findings_detail+=("$2")
}

# Per-script comparison so each drifted script is its own stable subject.
while IFS= read -r src; do
  rel="${src#"$REPO_DIR"/}"
  case "$rel" in *.bak*) continue ;; esac
  total=$((total + 1))
  dst="$DEST/$rel"
  if [ ! -f "$dst" ]; then
    finding "Provider script missing from the deployed set" \
      "[host $HOSTNAME_TAG] $rel exists in the repo but not at $DEST — a reinstall from the deployed tree runs WITHOUT it."
  elif ! cmp -s "$src" "$dst"; then
    finding "Provider script drifted from the repo" \
      "[host $HOSTNAME_TAG] $rel: repo $(wc -l <"$src") lines vs deployed $(wc -l <"$dst") — a reinstall silently DOWNGRADES this provider. Run deploy.sh to reconcile (after checking which side is newer)."
  fi
done < <(find "$REPO_DIR" -name '*.sh' -type f)

# Deployed-only scripts: the repo cannot rebuild them — reverse drift.
while IFS= read -r dst; do
  rel="${dst#"$DEST"/}"
  case "$rel" in *.bak*) continue ;; esac
  if [ ! -f "$REPO_DIR/$rel" ]; then
    total=$((total + 1))
    finding "Deployed provider script has no repo source" \
      "[host $HOSTNAME_TAG] $rel exists at $DEST but not in the repo — hand-edited live, or the repo lost it; either way the repo cannot rebuild this host."
  fi
done < <(find "$DEST" -name '*.sh' -type f)

# Sanity gate: fleets are ~30 scripts; the floor keeps tiny test trees and
# small installs on the honest per-script path.
GATE_MIN_TOTAL="${DRIFT_GATE_MIN_TOTAL:-10}"
if [ "$total" -ge "$GATE_MIN_TOTAL" ] && [ $((drifted * 2)) -ge "$total" ]; then
  emit warning "Provider drift check results look like a MISCONFIGURED check, not real drift" \
    "[host $HOSTNAME_TAG] $drifted of $total scripts reported drift in one run — when most of the fleet 'drifts' at once, the likeliest cause is the check itself (wrong AILAB_PROVIDER_REPO or DEST in the unit; that exact bug produced 66 warnings on 2026-08-31). Verify the unit's paths before trusting or acting on per-script results. First findings: ${findings_msg[0]}; ${findings_msg[1]:-}"
  echo "$drifted/$total drifted — over the sanity gate; ONE misconfiguration warning emitted instead of $drifted"
  exit 0
fi

i=0
while [ "$i" -lt "${#findings_msg[@]}" ]; do
  emit warning "${findings_msg[$i]}" "${findings_detail[$i]}"
  i=$((i + 1))
done

if [ "$drifted" -eq 0 ]; then
  echo "OK: repo and deployed provider scripts agree on $HOSTNAME_TAG"
else
  echo "$drifted drifted script(s) reported"
fi
exit 0
