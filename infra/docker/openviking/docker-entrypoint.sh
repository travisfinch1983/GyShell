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
# INHERIT, DON'T START EMPTY (claude1, 2026-10-16). The fingerprint includes the weights PATH and
# the model NAME, so a moved, renamed or re-quantized copy of the SAME model got a brand-new EMPTY
# workspace. Accounts and API keys live in the workspace, so every agent key became "Invalid API Key"
# for seven days (2026-10-09..16) while the health dot stayed green.
#
# Whether the old vectors are still valid is decided by MEASURING, not by comparing names. Every
# workspace carries _system/embed_canary.json: fixed texts plus the vectors they had. On a NEW
# fingerprint, the newest real workspace is copied in:
#   - viking/ (content, sessions, accounts, users.json = the agent API KEYS) and _system/: always;
#   - vectordb/: when the new model re-embeds the canaries to the same place (mean cos >= 0.98,
#     min >= 0.97), the index is copied and its model label rewritten to the new name, because
#     OpenViking refuses to boot on a label mismatch. A genuinely different model fails the canary,
#     so its vectors are NOT copied and a notification says to re-index. With no canary (older
#     workspace), it falls back to "same label" only.
# The source workspace is left untouched (rollback = point back at it).
# (FP8 vs W8A16 of the same model, measured 2026-10-16: cos 0.996, exact self-retrieval 25/25.)
if [ "${NEW_WS:-0}" = "1" ]; then
  INHERIT="$(python3 - "$ROOT" "$WS" "$RUNTIME" <<'PY'
import json, math, os, re, shutil, sys, urllib.request
root, ws, runtime = sys.argv[1], sys.argv[2], sys.argv[3]
dense = (json.load(open(runtime)).get("embedding") or {}).get("dense") or {}
model = dense.get("model") or ""
def embed(texts):
    h = {"Content-Type": "application/json"}
    if dense.get("api_key"): h["Authorization"] = "Bearer " + dense["api_key"]
    req = urllib.request.Request(dense["api_base"].rstrip("/") + "/embeddings",
                                 json.dumps({"model": model, "input": texts}).encode(), h)
    d = json.load(urllib.request.urlopen(req, timeout=60))
    return [x["embedding"] for x in sorted(d["data"], key=lambda x: x["index"])]
def cos(a, b):
    return sum(x*y for x, y in zip(a, b)) / ((math.sqrt(sum(x*x for x in a)) * math.sqrt(sum(y*y for y in b))) or 1)
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
meta_p = os.path.join(src, "vectordb", "context", "collection_meta.json")
ident = ""
try:
    m = re.search(r'model_identity\\?"\s*:\s*\\?"([^"\\]+)', open(meta_p).read())
    ident = m.group(1) if m else ""
except OSError:
    pass
for sub in ("viking", "_system"):
    if os.path.isdir(os.path.join(src, sub)):
        shutil.copytree(os.path.join(src, sub), os.path.join(ws, sub), symlinks=True, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.pid", "LOCK", "*-shm", "*-wal"))
verdict, why = "skipped", ""
canary_p = os.path.join(src, "_system", "embed_canary.json")
if os.path.isfile(canary_p) and os.path.isdir(os.path.join(src, "vectordb")):
    try:
        c = json.load(open(canary_p))
        sims = [cos(a, b) for a, b in zip(c["vectors"], embed(c["texts"]))]
        mean, mn = sum(sims) / len(sims), min(sims)
        why = f"canary mean {mean:.4f} min {mn:.4f} vs {c.get('label')}"
        if mean >= 0.98 and mn >= 0.97:
            verdict = "copied"
    except Exception as e:  # noqa: BLE001
        why = f"canary check failed: {e}"
elif ident and ident == model:
    verdict, why = "copied", "same model label (no canary in source)"
else:
    why = f"no canary in source and label differs ({ident} vs {model})"
if verdict == "copied":
    shutil.copytree(os.path.join(src, "vectordb"), os.path.join(ws, "vectordb"), symlinks=True, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("LOCK"))
    if ident and ident != model:
        mp = os.path.join(ws, "vectordb", "context", "collection_meta.json")
        mj = json.load(open(mp))
        mj["Description"] = mj["Description"].replace(f'"model": "{ident}"', f'"model": "{model}"').replace(
            f'"model_identity": "{ident}"', f'"model_identity": "{model}"')
        json.dump(mj, open(mp, "w"))
        why += f"; index relabelled {ident} -> {model}"
print(f"{os.path.basename(src)}|{verdict}|{why}")
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
      SRCWS="${INHERIT%%|*}"; REST="${INHERIT#*|}"; VEC="${REST%%|*}"; WHY="${REST#*|}"
      echo "openviking: new fingerprint $FP inherited workspace $SRCWS (vectors: $VEC; $WHY)" >&2
      if [ "$VEC" = "copied" ]; then
        emit_notify warning "OpenViking embed model changed - memory workspace inherited, vectors still valid" \
          "New fingerprint $FP (the embed model's name, path or quant changed). Accounts, agent keys, memories AND vectors were carried over from $SRCWS; the vectors were kept because $WHY. Nothing to do unless recall quality looks off. Source left intact for rollback."
      else
        emit_notify error "OpenViking embed model changed - memories inherited, vectors need a re-index" \
          "New fingerprint $FP. Accounts, agent keys and memories were carried over from $SRCWS, but the old vectors were NOT ($WHY): the new model embeds differently. Recall finds nothing until a re-index: POST /api/v1/content/reindex {\"uri\":\"viking://user/<agent>\",\"wait\":true} per namespace with the root key + X-OpenViking-Account/X-OpenViking-User headers."
      fi ;;
  esac
fi
# Seed the compatibility canary for this workspace if it has none (fixed texts + their vectors under
# the CURRENT model) so the next model change can be measured instead of guessed. Best effort.
if [ -d "$WS/vectordb" ] && [ ! -f "$WS/_system/embed_canary.json" ] && [ -w "$WS" ]; then
  python3 - "$WS" "$RUNTIME" <<'PY' || echo "openviking: canary seeding failed (non-fatal)" >&2
import json, os, sys, time, urllib.request
ws, runtime = sys.argv[1], sys.argv[2]
dense = (json.load(open(runtime)).get("embedding") or {}).get("dense") or {}
texts = ["The user prefers short replies with no bullet points.",
         "ComfyUI workflow failed because the LoRA strength key was named weight instead of strength_model.",
         "Kyla wants her face redrawn in anime style rather than pasted on.",
         "px-gpu hosts eight V100 GPUs; reboot the host through IPMI if a GPU wedges.",
         "Remember to water the tomato plants every morning before it gets hot.",
         "def fingerprint(model, root): return sha1(f'{model}|{root}').hexdigest()[:12]",
         "Zack is jailbreaking a PS5 on firmware 12.70 and loads games over FTP.",
         "A quiet rainy evening in a cozy cafe, warm light, steam rising from a mug of tea."]
h = {"Content-Type": "application/json"}
if dense.get("api_key"): h["Authorization"] = "Bearer " + dense["api_key"]
req = urllib.request.Request(dense["api_base"].rstrip("/") + "/embeddings",
                             json.dumps({"model": dense["model"], "input": texts}).encode(), h)
d = json.load(urllib.request.urlopen(req, timeout=60))
vecs = [x["embedding"] for x in sorted(d["data"], key=lambda x: x["index"])]
os.makedirs(os.path.join(ws, "_system"), exist_ok=True)
json.dump({"label": dense["model"], "served_model": d.get("model"), "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "texts": texts, "vectors": vecs}, open(os.path.join(ws, "_system", "embed_canary.json"), "w"))
print(f"openviking: seeded embed canary ({len(texts)} texts, model {d.get('model')})", file=sys.stderr)
PY
fi
echo "openviking: embed fingerprint $FP -> workspace $WS"
exec openviking-server --config "$RUNTIME"
