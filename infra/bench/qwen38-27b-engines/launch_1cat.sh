#!/bin/bash
# 1Cat battery launcher = production 1cat-vllm-5003.sh with model/port/name/speculation swapped.
# usage: launch_1cat.sh <nospec|mtp|dflash2> <model_dir>
MODE=${1:?mode}; MODEL_DIR=${2:?model dir}
DFLASH_DIR=$( [ -e /model-cache/Qwen3.8/27B-DFlash2/config.json ] && echo /model-cache/Qwen3.8/27B-DFlash2 || echo /models/Qwen3.8/27B-DFlash2 )  # config.json check: the GGUF cache entry creates the parent dir too
case $MODE in
  nospec)  SPEC_ARGS=() ;;
  mtp)     SPEC_ARGS=(--speculative-config '{"method":"qwen3_5_mtp","num_speculative_tokens":3}') ;;
  dflash2) SPEC_ARGS=(--speculative-config '{"method": "dflash", "model": "'"$DFLASH_DIR"'", "num_speculative_tokens": 7, "ngram_assist": true}') ;;
  *) echo "bad mode"; exit 2 ;;
esac
# ProxLab managed service — 1cat-vllm on port 5003
# Generated: 2026-09-29T20:29:16.408Z
# ── AI-Lab GPU pin: cards by UUID (else PCI) -> index among ATTACHED cards at launch; refuse if absent ──
AILAB_GPU_PINS="0000:8a:00.0=GPU-0da2f698-2d8c-9398-47e5-52ca4f56fae8 0000:8b:00.0=GPU-bfbf79d2-86ed-7ec6-89fe-e81b3de1bd8d 0000:8c:00.0=GPU-f6cf8331-8638-f599-aef7-1d421d9e6497 0000:8d:00.0=GPU-bf4a3031-f808-0ec2-9e40-8be00ad8716b"
export CUDA_DEVICE_ORDER=PCI_BUS_ID
_attached=""
for _d in /proc/driver/nvidia/gpus/*; do
  _m=$(sed -n "s/^Device Minor:[[:space:]]*//p" "$_d/information" 2>/dev/null)
  [ -n "$_m" ] && [ -e "/dev/nvidia$_m" ] && _attached="$_attached $(basename "$_d" | tr A-F a-f)"
done
_attached=$(printf "%s\n" $_attached | sort)
AILAB_CVD=""
for _pin in $AILAB_GPU_PINS; do
  _pci=${_pin%%=*}; _uuid=""; [ "$_pin" != "$_pci" ] && _uuid=${_pin#*=}
  _use=""
  if [ -n "$_uuid" ]; then
    for _p in $_attached; do
      _u=$(sed -n "s/^GPU UUID:[[:space:]]*//p" "/proc/driver/nvidia/gpus/$_p/information" 2>/dev/null)
      [ "$(echo "$_u" | tr A-F a-f)" = "$(echo "$_uuid" | tr A-F a-f)" ] && { _use=$_p; break; }
    done
    [ -z "$_use" ] && { echo "AI-LAB GPU PIN: GPU $_uuid (pinned at $_pci) is NOT attached to this container (attached: $(echo $_attached)) -- refusing to start rather than run on a different card"; exit 78; }
    [ "$_use" != "$_pci" ] && echo "AI-LAB GPU PIN: $_uuid moved $_pci -> $_use; following the card"
  else
    printf "%s\n" $_attached | grep -qx "$_pci" && _use=$_pci
    [ -z "$_use" ] && { echo "AI-LAB GPU PIN: GPU $_pci is NOT attached to this container (attached: $(echo $_attached)) -- refusing to start rather than run on a different card"; exit 78; }
  fi
  _idx=$(printf "%s\n" $_attached | grep -nx "$_use" | cut -d: -f1)
  AILAB_CVD="${AILAB_CVD:+$AILAB_CVD,}$((_idx - 1))"
done
export CUDA_VISIBLE_DEVICES="$AILAB_CVD"
echo "AI-LAB GPU PIN: $AILAB_GPU_PINS -> CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES (PCI order among attached)"
mc(){ p="$1"; case "$p" in
  /model-cache/*) c="$p"; n="/models/${p#/model-cache/}";;
  /models/*) n="$p"; c="/model-cache/${p#/models/}";;
  *) printf "%s" "$p"; return ;; esac
  if [ -e "$c" ]; then printf "%s" "$c"; else printf "%s" "$n"; fi; }
# CUDA toolchain: tilelang JIT resolves CUDA via nvcc on PATH, not via torch.
case ":$PATH:" in *":/opt/conda/envs/1cat-vllm-sm70-150/bin:"*) ;; *) export PATH="/opt/conda/envs/1cat-vllm-sm70-150/bin:$PATH" ;; esac
# CUDA_HOME is set UNCONDITIONALLY, unlike the tunables below: an inherited value from another
# conda env (observed in practice: /opt/conda/envs/alltalk) points the toolchain at the wrong
# CUDA, and a wrong CUDA_HOME is worse than an unset one.
export CUDA_HOME="/opt/conda/envs/1cat-vllm-sm70-150"
# ── 1Cat-vLLM SM70 runtime env (auto-emitted; override by exporting these first) ──
: "${VLLM_DISABLED_KERNELS:=MarlinLinearKernel}"; export VLLM_DISABLED_KERNELS
: "${VLLM_SM70_QUANT_BACKEND:=turbomind}"; export VLLM_SM70_QUANT_BACKEND
: "${VLLM_SM70_QWEN_GDN_FULL_FORWARD:=1}"; export VLLM_SM70_QWEN_GDN_FULL_FORWARD
: "${VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS:=1800}"; export VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS
# ── Optane KV offload (auto-wired by AI-Lab; patches: optane-gdn-fix) ──────────
KV_ARGS=()
_kvdir="/optane-sock1/vllm-kv/qwen3.8-27b-int8-w8a16-mtp-tp4-284d2f55"
_kvpy="/opt/conda/envs/1cat-vllm-sm70-150/bin/python"
if [ ! -d "/optane-sock1/vllm-kv" ]; then
  echo "[kv] no Optane pool at /optane-sock1/vllm-kv -> KV offload OFF" >&2
elif [ ! -x "$_kvpy" ]; then
  echo "[kv] no interpreter at $_kvpy -> KV offload OFF" >&2
else
  # Gate on the patched CODE itself, never on a marker file. A marker proved nothing: pip does not
  # delete files it does not own, so the 1.3.0 marker survived the 1.5.0 upgrade while the patched
  # files were replaced, and this gate would have wired an unpatched engine. Grep each patched file
  # for its tag instead -- an upgrade that replaces the file removes the tag with it.
  #   GROUPFIX: drain the pending cudaHostRegister error (ranks >= 1 otherwise die at warmup) and
  #             count distinct block sizes, not KV groups (hybrid models always have > 1 group).
  #   RINGSKIP: never look up / store / load non-prefix-cacheable groups (Flash-Next QSA ring).
  #   PATHFIX:  key the snapshot dir by model identity, not /model-cache vs /models, so every
  #             instance of the same model (any GPU, any mount) shares one pool.
  # Verified 2026-09-28 on 1Cat 1.5.0: 27B (MTP on) + 9B + Flash-Next NVFP4 all byte-exact.
  _kvver=$("$_kvpy" -c 'import sys;print("python%d.%d"%sys.version_info[:2])' 2>/dev/null)
  _kvpkg="/opt/conda/envs/1cat-vllm-sm70-150/lib/$_kvver/site-packages/vllm"
  _kvmiss=""
  _kvreq="GROUPFIX:v1/kv_offload/tiering/spec.py GROUPFIX:v1/kv_offload/cpu/gpu_worker.py"
  _kvreq="$_kvreq RINGSKIP:distributed/kv_transfer/kv_connector/v1/offloading/scheduler.py"
  _kvreq="$_kvreq RINGSKIP:distributed/kv_transfer/kv_connector/v1/offloading/worker.py"
  _kvreq="$_kvreq PATHFIX:v1/kv_offload/file_mapper.py"
  for _kvp in $_kvreq; do
    grep -q "$(echo "$_kvp" | cut -d: -f1)" "$_kvpkg/$(echo "$_kvp" | cut -d: -f2)" 2>/dev/null || _kvmiss="$_kvmiss $_kvp"
  done
  if [ -n "$_kvmiss" ]; then
    echo "[kv] required patches missing in $_kvpkg:$_kvmiss -> KV offload OFF" >&2
  else
    mkdir -p "$_kvdir"
    # Each Tiering engine maps a /dev/shm region sized cpu_bytes_to_use and does NOT unlink it on
    # exit, so restarts leak one region per launch until /dev/shm is full. Reclaim any region no
    # process still holds open; never touch one that is in use by a live engine.
    for _f in /dev/shm/vllm_offload_*.mmap; do
      [ -e "$_f" ] || continue
      if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -t -- "$_f" 2>/dev/null)" ]; then continue; fi
      echo "[kv] reclaiming orphaned KV shm region: $_f" >&2
      rm -f -- "$_f"
    done
    # RAM tier size is taken from what /dev/shm can ACTUALLY give right now, capped at 64GiB.
    # Sizing this way means a second engine on the same node gets a smaller tier instead of failing
    # to allocate — no cross-service coordination needed.
    _availkb=$(df -Pk /dev/shm | awk 'NR==2{print $4}')
    _bytes=$(( _availkb * 1024 * 6 / 10 ))
    _cap=$(( 64 * 1073741824 ))
    [ "$_bytes" -gt "$_cap" ] && _bytes=$_cap
    if [ "$_bytes" -lt $(( 8 * 1073741824 )) ]; then
      echo "[kv] only $(( _bytes / 1048576 ))MiB of /dev/shm available -> KV offload OFF" >&2
    else
      # Block hashes MUST be identical across restarts or nothing can ever be restored: vLLM
      # seeds NONE_HASH from os.urandom() whenever PYTHONHASHSEED is unset, so every restart
      # would otherwise compute different keys for the same tokens and miss 100%.
      export PYTHONHASHSEED=0
      # Eviction signal for the pruner. The fs tier alone cannot supply one (noatime, and hot
      # blocks are served from RAM so their files are never read); the manager sees every lookup.
      export VLLM_KV_HOTNESS_PATH="$_kvdir/hotness.json"
      export VLLM_KV_HOTNESS_FLUSH=64
      _kvcfg=$(printf '{"kv_connector":"OffloadingConnector","kv_role":"kv_both","kv_connector_extra_config":{"spec_name":"TieringOffloadingSpec","cpu_bytes_to_use":%s,"eviction_policy":"lru","secondary_tiers":[{"type":"fs","root_dir":"%s","n_read_threads":16,"n_write_threads":4}]}}' "$_bytes" "$_kvdir")
      # --no-disable-hybrid-kv-cache-manager: without it the engine turns HMA off as soon as a
      #   transfer config is present, which hard-fails every hybrid GDN model.
      # --mamba-cache-mode all: one page per block, so a restored block maps to exactly one
      #   recurrent state. Measured cost at 262k context on the 27B: none (GPU KV cache unchanged
      #   at 1,125,767 tokens).
      # n_write_threads=4: Optane is fsdax, so every block store is a CPU memcpy (no DMA). At 16
      # threads the flush-heavy gate held ~15 cores and starved nvidia-smi (gpu-exporter timeouts,
      # 2026-09-29). Stores are background work; reads stay at 16 so restores stay fast.
      KV_ARGS=()  # DISABLED 2026-10-07: restore corrupts output under DFlash/align (see CT152 ai-lab.service.d/10-kv-offload-off.conf)
      echo "[kv] Optane KV DISABLED (restore corrupts output, 2026-10-07); would be dir=$_kvdir ram_tier=$(( _bytes / 1073741824 ))GiB" >&2
    fi
  fi
fi
export CUDA_DEVICE_ORDER=PCI_BUS_ID
export CUDA_VISIBLE_DEVICES="$AILAB_CVD"
KV_ARGS=()  # bench copy: never touch the prod KV snapshot pool
/opt/conda/envs/1cat-vllm-sm70-150/bin/vllm serve \
  "$MODEL_DIR" \
  --port 5095 \
  --host 127.0.0.1 \
  --tensor-parallel-size 4 \
  --max-model-len 262144 \
  --max-num-seqs 8 \
  --gpu-memory-utilization 0.90 \
  --dtype half \
  --kv-cache-dtype fp8_e5m2 \
  --enable-prefix-caching \
  --served-model-name bench-1cat \
  --chat-template /opt/1cat-vllm/qwen_sharp_chat_template.jinja \
  --pipeline-parallel-size 1 \
  --data-parallel-size 1 \
  --load-format auto \
  --tokenizer-mode auto \
  --chat-template-content-format auto \
  --response-role assistant \
  --attention-backend FLASH_ATTN_V100 \
  --limit-mm-per-prompt.image 5 \
  --max-loras 1 \
  --max-lora-rank 16 \
  "${SPEC_ARGS[@]}" \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml \
  --reasoning-parser qwen3 \
  --uvicorn-log-level info \
  --default-chat-template-kwargs '{"preserve_thinking": true}' \
  --mamba-cache-mode all ${KV_ARGS[@]+"${KV_ARGS[@]}"}
