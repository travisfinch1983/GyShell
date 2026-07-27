#!/bin/sh
# Pick OpenViking's workspace from the FINGERPRINT of the embedding model it is
# configured to use, so each encoder gets its own store.
#
# Why: OpenViking keeps its own vector index in the workspace rather than in a
# shared vector DB, so there is no collection name to suffix (unlike qdrant).
# Mixing encodings in one workspace would silently degrade recall — vectors from
# different quantisations of the SAME model name sit only ~0.96 apart, which
# looks plausible and ranks wrong. A per-fingerprint workspace makes a model
# change start clean instead of contaminating the existing index.
#
# The fingerprint matches the unified memory MCP's:  sha1(model_id|root)[:12]
# where `root` is the weights path reported by GET <api_base>/models. The served
# NAME alone is insufficient — one name covers several quants.
#
# ov.conf is mounted READ-ONLY, so we emit a runtime copy with the workspace
# path substituted and launch against that.
set -e
SRC="${OV_CONFIG:-/root/.openviking/ov.conf}"
RUNTIME=/tmp/ov.runtime.conf
ROOT="${OV_WORKSPACE_ROOT:-/opt/openviking/workspaces}"

FP="$(python3 - "$SRC" <<'PY'
import hashlib, json, sys, urllib.request
cfg = json.load(open(sys.argv[1]))
dense = (cfg.get("embedding") or {}).get("dense") or {}
base  = (dense.get("api_base") or "").rstrip("/")
model = dense.get("model") or ""
try:
    data = json.load(urllib.request.urlopen(base + "/models", timeout=10)).get("data") or []
    entry = next((m for m in data if m.get("id") == model), None)
    print(hashlib.sha1(f"{model}|{(entry or {}).get('root','')}".encode()).hexdigest()[:12] if entry else "")
except Exception as e:
    print("", file=sys.stderr); print(f"fingerprint probe failed: {e}", file=sys.stderr)
    print("")
PY
)"

if [ -z "$FP" ]; then
  # Refuse to guess: an unknown encoder writing into another encoder's workspace
  # is exactly the corruption this exists to prevent.
  echo "FATAL: could not fingerprint the embedding model (endpoint unreachable?)." >&2
  echo "       Refusing to start rather than risk writing into the wrong workspace." >&2
  exit 1
fi

WS="$ROOT/$FP"
mkdir -p "$WS"
python3 - "$SRC" "$RUNTIME" "$WS" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
cfg.setdefault("storage", {})["workspace"] = sys.argv[3]
json.dump(cfg, open(sys.argv[2], "w"), indent=2)
PY
echo "openviking: embed fingerprint $FP -> workspace $WS"
exec openviking-server --config "$RUNTIME"
