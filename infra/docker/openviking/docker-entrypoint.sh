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
    if entry is None and len(data) == 1:
        # ov.conf pinned a name AI-Lab no longer serves. The proxy serves exactly ONE embed
        # model, so that IS the Support Models selection -- use it rather than refusing to
        # boot. A stale pin here crash-looped this container 4149 times.
        entry = data[0]
        print(f"openviking: ov.conf names {model!r} which is not served; "
              f"using the proxy's only model {entry.get('id')!r}", file=sys.stderr)
    print(hashlib.sha1(f"{entry['id']}|{entry.get('root','')}".encode()).hexdigest()[:12] if entry else "")
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
# Also take vlm.model from AI-Lab's Support Models file (role `memory_vlm`) so the model
# is controlled in the UI rather than pinned in ov.conf. File wins; ov.conf is the fallback
# — a missing/unreadable file must never blank a working config.
SM=/ai-lab-data/hermes-support-models.json
python3 - "$SRC" "$RUNTIME" "$WS" "$SM" <<'PY'
import json, sys, urllib.request
cfg = json.load(open(sys.argv[1]))
cfg.setdefault("storage", {})["workspace"] = sys.argv[3]

# embed model <- what the AI-Lab proxy actually serves (Support Models drives the proxy).
# Without this the runtime config keeps a name that 404s on every embed call, which is how
# embeddings silently stopped while the service looked healthy.
_dense = (cfg.get("embedding") or {}).get("dense") or {}
_base = (_dense.get("api_base") or "").rstrip("/")
try:
    _data = json.load(urllib.request.urlopen(_base + "/models", timeout=15)).get("data") or []
    _want = _dense.get("model") or ""
    if not any(m.get("id") == _want for m in _data) and len(_data) == 1:
        print(f"openviking: embedding.dense.model <- {_data[0]['id']!r} (was {_want!r})", file=sys.stderr)
        cfg["embedding"]["dense"]["model"] = _data[0]["id"]
except Exception as _e:
    print(f"openviking: embed /models unreadable ({_e}); keeping ov.conf embed model", file=sys.stderr)
want = ""
try:
    sm = json.load(open(sys.argv[4]))
    want = ((sm.get("memory_vlm") or {}).get("model") or "")
except FileNotFoundError:
    print("openviking: support-models not mounted; keeping ov.conf vlm.model", file=sys.stderr)
except Exception as e:
    print(f"openviking: support-models unreadable ({e}); keeping ov.conf vlm.model", file=sys.stderr)
if want:
    cur = (cfg.get("vlm") or {}).get("model") or ""
    if cur != want:
        print(f"openviking: vlm.model <- support-models[memory_vlm] = {want!r} (was {cur!r})", file=sys.stderr)
    cfg.setdefault("vlm", {})["model"] = want
json.dump(cfg, open(sys.argv[2], "w"), indent=2)
PY
echo "openviking: embed fingerprint $FP -> workspace $WS"
exec openviking-server --config "$RUNTIME"
