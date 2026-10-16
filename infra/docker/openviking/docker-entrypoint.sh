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
    substituted = 0
    if entry is None and len(data) == 1:
        # ov.conf pinned a name AI-Lab no longer serves; the proxy serves exactly
        # ONE embed model. Whether adopting it is safe depends on whether ITS
        # workspace already exists -- that decision lives in shell below, which
        # is why the substitution FLAG travels with the fingerprint. (Silently
        # adopting it used to mkdir a fresh EMPTY workspace: boots healthy,
        # zero memories -- it traded the 4149-restart crash-loop for silent
        # total memory loss.)
        entry = data[0]
        substituted = 1
        print(f"openviking: ov.conf names {model!r} which is not served; "
              f"proxy's only model is {entry.get('id')!r}", file=sys.stderr)
    fp = hashlib.sha1(f"{entry['id']}|{entry.get('root','')}".encode()).hexdigest()[:12] if entry else ""
    print(f"{fp} {substituted}")
except Exception as e:
    print(f"fingerprint probe failed: {e}", file=sys.stderr)
    print(" 0")
PY
)"
SUBSTITUTED="${FP#* }"
FP="${FP%% *}"

# Best-effort notification -- a crash-looping or degraded container's stderr is
# journald-only, which is where the 12-day outage lived. Never fatal.
emit_notify() { # severity message detail
  python3 - "$1" "$2" "$3" <<'PY' || echo "NOTIFY LOST" >&2
import json, sys, urllib.request, os
body = json.dumps({"severity": sys.argv[1], "source": "memory-workspace",
                   "message": sys.argv[2],
                   "detail": f"[host {os.uname().nodename}] {sys.argv[3]}"}).encode()
req = urllib.request.Request((os.environ.get("AILAB_API_URL", "http://10.0.0.219:17890"))
                             + "/api/notifications/emit", body,
                             {"Content-Type": "application/json"}, method="POST")
urllib.request.urlopen(req, timeout=5).read()
PY
}

if [ -z "$FP" ]; then
  # Refuse to guess: an unknown encoder writing into another encoder's workspace
  # is exactly the corruption this exists to prevent.
  echo "FATAL: could not fingerprint the embedding model (endpoint unreachable?)." >&2
  echo "       Refusing to start rather than risk writing into the wrong workspace." >&2
  emit_notify critical "OpenViking refused to start - embedding model unfingerprintable" \
    "The embed endpoint was unreachable or served no model, so the workspace identity cannot be resolved. Refusing beats guessing; memory capture is DOWN until the embed pool answers. The container will crash-loop until then - the designed loud failure, not a fault to silence."
  exit 1
fi

# REFUSE-LOUDLY CONTRACT (claude1's ruling, 2026-08-31; same shape as the
# roadmap store): a substitution may CONTINUE an existing workspace, but must
# never CREATE one. Two things answering to one identity is the ambiguity that
# burned real hours; a fresh empty workspace born from a model rename is silent
# total memory loss wearing a green health dot.
if [ "$SUBSTITUTED" = "1" ] && [ ! -d "$ROOT/$FP" ]; then
  QUARANTINE="$ROOT/UNRESOLVED-DO-NOT-USE-$FP"
  mkdir -p "$QUARANTINE"
  {
    echo "This is NOT a real OpenViking workspace."
    echo "ov.conf names an embed model the proxy no longer serves, and no workspace"
    echo "exists for the substitute's fingerprint ($FP). Creating one would be"
    echo "silent memory loss. Fix Support Models (or ov.conf) so the configured"
    echo "model matches an existing workspace, then restart this container."
  } > "$QUARANTINE/README-UNRESOLVED.txt" 2>/dev/null || true
  chmod 555 "$QUARANTINE" || true
  existing="$(ls "$ROOT" 2>/dev/null | tr '\n' ' ')"
  echo "openviking: REFUSING the substituted workspace - booting DEGRADED against read-only $QUARANTINE" >&2
  emit_notify critical "OpenViking is running WITHOUT its memory workspace" \
    "ov.conf's embed model is not served and the substitute's fingerprint ($FP) has no existing workspace - creating one would be silent memory loss, so the service is up DEGRADED against a read-only quarantine dir: every capture write fails visibly. Existing workspaces: ${existing:-none}. Repair: point Support Models (or ov.conf) at the model matching the workspace you want, then restart."
  WS="$QUARANTINE"
elif [ "$SUBSTITUTED" = "1" ]; then
  # The substitute's workspace ALREADY EXISTS: using it continues an
  # established identity rather than manufacturing one. Safe, but said.
  echo "openviking: substituted model's workspace exists - CONTINUING $ROOT/$FP" >&2
  emit_notify warning "OpenViking substituted its embed model (existing workspace continued)" \
    "ov.conf's model is not served; the proxy's only embed model maps to fingerprint $FP whose workspace already exists - continuing it. Update ov.conf/Support Models so the names agree and this warning stops."
  WS="$ROOT/$FP"
  mkdir -p "$WS"
else
  WS="$ROOT/$FP"
  NEW_WS=0
  [ -d "$WS" ] || NEW_WS=1
  mkdir -p "$WS"
fi
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
# INHERIT, DON'T START EMPTY (claude1, 2026-10-16). The fingerprint includes the weights PATH, so
# the SAME model moved or re-quantized (FP8 -> W8A16 on 2026-10-09) got a brand-new EMPTY workspace.
# Accounts and API keys live in the workspace, so every agent key became "Invalid API Key" for
# seven days while the health dot stayed green. When a fingerprint is NEW, copy the most recently
# used real workspace into it instead:
#   - viking/ (content, sessions, accounts, users.json = the agent API KEYS) and _system/ always;
#   - vectordb/ only when its model_identity equals the runtime embed model. That is the label
#     OpenViking itself enforces: if they differ it refuses to boot, so the vectors must be rebuilt
#     with a re-index. If they match, the vectors are accepted as-is. (Measured FP8 vs W8A16 for the
#     same text: cosine 0.996, exact self-retrieval 25/25.)
# The source workspace is left untouched (rollback = point back at it).
if [ "${NEW_WS:-0}" = "1" ]; then
  INHERIT="$(python3 - "$ROOT" "$WS" "$RUNTIME" <<'PY'
import json, os, re, shutil, sys
root, ws, runtime = sys.argv[1], sys.argv[2], sys.argv[3]
model = ((json.load(open(runtime)).get("embedding") or {}).get("dense") or {}).get("model") or ""
def newest(d):
    t = 0
    for dp, _, fs in os.walk(os.path.join(d, "viking")):
        for f in fs:
            try: t = max(t, os.path.getmtime(os.path.join(dp, f)))
            except OSError: pass
    return t
cands = []
for n in os.listdir(root):
    d = os.path.join(root, n)
    if d == ws or not os.path.isdir(d) or n.startswith("UNRESOLVED") or "." in n:
        continue
    vk = os.path.join(d, "viking")
    if os.path.isdir(vk) and any(os.path.isfile(os.path.join(vk, a, "_system", "users.json")) for a in os.listdir(vk)):
        cands.append((newest(d), d))
if not cands:
    print("none"); sys.exit(0)
src = max(cands)[1]
ident = ""
try:
    m = re.search(r'model_identity\\?"\s*:\s*\\?"([^"\\]+)', open(os.path.join(src, "vectordb", "context", "collection_meta.json")).read())
    ident = m.group(1) if m else ""
except OSError:
    pass
for sub in ("viking", "_system"):
    if os.path.isdir(os.path.join(src, sub)):
        shutil.copytree(os.path.join(src, sub), os.path.join(ws, sub), symlinks=True, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.pid", "LOCK", "*-shm", "*-wal"))
vec = "skipped"
if ident and ident == model and os.path.isdir(os.path.join(src, "vectordb")):
    shutil.copytree(os.path.join(src, "vectordb"), os.path.join(ws, "vectordb"), symlinks=True, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("LOCK"))
    vec = "copied"
print(f"{os.path.basename(src)}|{vec}|{ident}|{model}")
PY
)" || INHERIT="error"
  case "$INHERIT" in
    none)
      echo "openviking: new workspace $WS and no earlier workspace to inherit - starting empty (first boot?)" >&2
      emit_notify warning "OpenViking started a NEW EMPTY memory workspace" \
        "Embed fingerprint $FP had no workspace and no earlier workspace with accounts was found under $ROOT. If this is not a first install, agent memory keys will fail - restore an old workspace into $WS." ;;
    error|"")
      echo "openviking: workspace inheritance FAILED for $WS" >&2
      emit_notify critical "OpenViking could not inherit its memory workspace" \
        "Embed fingerprint $FP is new and copying the previous workspace failed. It is running on an EMPTY workspace: every agent memory key will be rejected. Restore the most recent workspace under $ROOT into $WS." ;;
    *)
      SRCWS="${INHERIT%%|*}"; REST="${INHERIT#*|}"; VEC="${REST%%|*}"
      echo "openviking: new fingerprint $FP inherited workspace $SRCWS (vectors: $VEC)" >&2
      if [ "$VEC" = "copied" ]; then
        emit_notify warning "OpenViking embed fingerprint changed - memory workspace inherited" \
          "The embed model's weights path or quant changed (new fingerprint $FP). Accounts, agent keys, memories AND vectors were copied from $SRCWS (same model_identity, so the vectors stay valid). Nothing to do unless recall quality looks off. Source left intact for rollback."
      else
        emit_notify error "OpenViking embed model changed - memories inherited, vectors need a re-index" \
          "New fingerprint $FP. Accounts, agent keys and memories were copied from $SRCWS, but its vectors belong to a different model label ($REST), so they were NOT copied. Recall finds nothing until a re-index: POST /api/v1/content/reindex {\"uri\":\"viking://user/<agent>\"} per namespace with the root key + X-OpenViking-Account/X-OpenViking-User headers."
      fi ;;
  esac
fi
echo "openviking: embed fingerprint $FP -> workspace $WS"
exec openviking-server --config "$RUNTIME"
