#!/bin/bash
# Qwen-Image 2.1 prompt-enhancer ROUTER (claude1, 2026-10-16) - one llama-server in router mode
# serving BOTH PE models from one GPU, at most one loaded at a time (--models-max 1, passed by the
# caller). Requesting the unloaded model makes llama.cpp unload the other and load it, so ComfyUI
# and the agents always see both ids in /v1/models and swaps happen on demand, with no AI-Lab
# suspend/start juggling.
#
# Run by an AI-Lab llama-server service (launched via /api/ai/launch-service, which adds the GPU pin,
# systemd unit and registration). Lives OUTSIDE /opt/proxlab/services because ai.js regenerates
# everything in there.
#
# Model files (claude2, 2026-10-16): the image model service's cache tiers hold them, UNPINNED, with its
# normal decayed-LRU scoring (kind "llm", names relative to /models). First existing copy wins:
#   /model-cache/ailab-modelsvc/llm/<rel>   RAM tier
#   /disk-cache/ailab-modelsvc/llm/<rel>    persistent disk tier (survives reboots)
#   /model-cache/<rel>                      the LLM model cacher (legacy - until those entries are uncached)
#   /models/<rel>                           NAS
# Copies are made atomically (.part + rename), so an existing file is always complete; pruning only ever
# drops a tier, never breaks a load. The preset is rewritten on every start, so a model entering or
# leaving a tier is picked up on the next restart. Each start also reports a use of the three files to
# the service (POST :9312/cache/warm {kind:llm, use:true}) - that keeps their scores up and re-stages a
# missing copy (disk first, then RAM). Per-request use is reported by the AI-Lab proxy.
set -euo pipefail

MODELSVC=${MODELSVC:-http://127.0.0.1:9312}
mc() {
  local p="$1" r c; r="${p#/models/}"
  for c in "/model-cache/ailab-modelsvc/llm/$r" "/disk-cache/ailab-modelsvc/llm/$r" "/model-cache/$r"; do
    if [ -e "$c" ]; then printf '%s' "$c"; return; fi
  done
  printf '%s' "$p"
}
# count a use + re-stage misses in the background (never blocks or fails the launch)
warm() { (curl -s -m 900 -X POST -H 'Content-Type: application/json' \
  -d "{\"kind\":\"llm\",\"name\":\"${1#/models/}\",\"use\":true}" "$MODELSVC/cache/warm" >/dev/null 2>&1 &) ; }

T2I=$(mc /models/Qwen-Image-2.1-PE/T2I-Heretic/GGUF/Q4_K_M/pe_t2i_heretic-Q4_K_M.gguf)
I2I=$(mc /models/Qwen-Image-2.1-PE/I2I-Heretic/GGUF/Q4_K_M/Qwen-Image-2.1-PE-I2I-Heretic-Q4_K_M.gguf)
MMPROJ=$(mc /models/Qwen-Image-2.1-PE/I2I-Heretic/GGUF/mmproj/Qwen-Image-2.1-PE-I2I-Heretic-mmproj-F16.gguf)
for f in "$T2I" "$I2I" "$MMPROJ"; do [ -r "$f" ] || { echo "qwen-pe-router: missing model file $f" >&2; exit 1; }; done
for f in /models/Qwen-Image-2.1-PE/T2I-Heretic/GGUF/Q4_K_M/pe_t2i_heretic-Q4_K_M.gguf \
         /models/Qwen-Image-2.1-PE/I2I-Heretic/GGUF/Q4_K_M/Qwen-Image-2.1-PE-I2I-Heretic-Q4_K_M.gguf \
         /models/Qwen-Image-2.1-PE/I2I-Heretic/GGUF/mmproj/Qwen-Image-2.1-PE-I2I-Heretic-mmproj-F16.gguf; do warm "$f"; done

# Router mode also lists everything in llama.cpp's download cache (~/.cache/llama.cpp: stray
# DanTagGen GGUFs). Point it at an empty dir so only the two presets are offered.
export LLAMA_CACHE=/run/qwen-pe-router-empty-cache
mkdir -p "$LLAMA_CACHE"

PRESET=/run/qwen-pe-router.ini
cat > "$PRESET" <<EOF
version = 1

; Shared settings, copied from the single-model services (llama-server-5006/5009, 2026-10-16).
[*]
ctx-size = 32768
gpu-layers = 999
flash-attn = auto
parallel = 1
jinja = true
batch-size = 2048
ubatch-size = 512
cache-prompt = true
cache-ram = 8192
slot-prompt-similarity = 0.5
cache-type-k = f16
cache-type-v = f16
split-mode = layer
fit = on
main-gpu = 0
reasoning = auto
reasoning-budget = 0
chat-template-kwargs = {"enable_thinking": false}
temp = 1
top-k = 20
top-p = 0.95
min-p = 0.05
repeat-penalty = 1.05
metrics = true
slots = true
stop-timeout = 5

[qwen-image-2.1-pe-t2i-heretic]
model = $T2I

[qwen-image-2.1-pe-i2i-heretic]
model = $I2I
mmproj = $MMPROJ
EOF
echo "qwen-pe-router: t2i=$T2I i2i=$I2I mmproj=$MMPROJ" >&2
exec /opt/llama-server/run.sh --models-preset "$PRESET" "$@"
