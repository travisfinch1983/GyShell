#!/bin/bash
# Deploy provider install scripts from the repo into the AI-Lab data dir.
#
#   ./deploy.sh          — copy repo -> data dir (repo wins)
#   ./deploy.sh --check  — report drift WITHOUT writing anything; exit 1 if any
#
# WHY THIS EXISTS
# ---------------
# The backend runs provider installers out of .gybackend-data/scripts/providers/,
# which is gitignored (it lives inside the runtime data dir). For a long time that
# meant the installers had NO version control at all.
#
# That is not a theoretical problem. On 2026-07-29 we found the server.py embedded
# in proxlab-tts.sh was 374 lines while the server.py actually running on ai-gpu was
# 461 lines — the installer had never been updated after silence-trimming was added
# live. Reinstalling the provider would have silently DOWNGRADED it and thrown away
# the trimming. Nothing detected this because the two copies were never compared.
#
# So: the repo is the source of truth, and `--check` is the thing that catches the
# next instance of that drift. Run --check before assuming an installer is current.
#
# NOTE: an installer that embeds a server file (proxlab-tts.sh, rvc.sh) is only as
# current as the last time someone re-embedded it. --check compares repo vs data dir;
# it CANNOT tell you the embedded copy matches what is deployed on the GPU nodes.
# That comparison is manual — diff against /opt/<provider>/server.py on the node.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/providers"
DEST="${AILAB_DATA_DIR:-/opt/ai-lab/.gybackend-data}/scripts/providers"

if [ ! -d "$SRC" ]; then
    echo "ERROR: source tree not found: $SRC" >&2
    exit 1
fi

if [ "${1:-}" = "--check" ]; then
    if [ ! -d "$DEST" ]; then
        echo "DRIFT: destination does not exist: $DEST"
        exit 1
    fi
    # Compare both directions so we catch repo-is-stale as well as node-is-stale.
    if diff -r --exclude='*.bak*' "$SRC" "$DEST" > /tmp/provider-drift.$$ 2>&1; then
        echo "OK: repo and data dir agree ($(find "$SRC" -name '*.sh' | wc -l) scripts)"
        rm -f /tmp/provider-drift.$$
        exit 0
    fi
    echo "DRIFT between repo and data dir:"
    sed 's/^/  /' /tmp/provider-drift.$$
    rm -f /tmp/provider-drift.$$
    exit 1
fi

mkdir -p "$DEST"
# --exclude the backups patch scripts leave behind; they are not deliverables.
rsync -a --exclude='*.bak*' "$SRC"/ "$DEST"/
chmod +x "$DEST"/*.sh "$DEST"/prereqs/*.sh 2>/dev/null || true
echo "Deployed $(find "$SRC" -name '*.sh' | wc -l) provider scripts -> $DEST"
