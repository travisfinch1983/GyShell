#!/bin/bash
# llama.cpp TP4 server for the HauhauCS Qwen3.8-27B Q8_K_P benchmark battery.
# usage: launch_llama.sh <base|mtp|dflash2|fastmtp> [split: tensor|layer] [draft depth]
# GPUs 8a-8d (PCI order 0-3) -- production 1cat-vllm-5003 must be SUSPENDED first.
# Tensor mode: needs --fit off, explicit -ts, f16 KV (memory reference-v100-llamacpp-tp-split-modes).
MODE=${1:?mode}; SPLIT=${2:-tensor}; DEPTH=${3:-}
BIN=/opt/llama-fastmtp/src/build/bin
C=/model-cache/Qwen3.8/27B-Uncensored-HauhauCS-Aggressive-MTP/GGUF
TARGET=$C/Q8_K/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf
FASTMTP=$C/FastMTP/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-FastMTP-32K.gguf
DFLASH2=/model-cache/Qwen3.8/27B-DFlash2/GGUF/BF16/Qwen3.8-27B-DFlash2-BF16.gguf
export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=0,1,2,3
export LD_LIBRARY_PATH=$BIN:/opt/cuda-12.9/lib64:/opt/nccl-for-llama/lib:$LD_LIBRARY_PATH

SPEC=()
case $MODE in
  base)    ;;
  mtp)     SPEC=(--spec-type draft-mtp --spec-draft-n-max ${DEPTH:-3} --spec-draft-p-min 0) ;;
  fastmtp) SPEC=(--spec-type draft-mtp --spec-draft-model "$FASTMTP" --spec-draft-ngl all
                 --spec-draft-n-max ${DEPTH:-3} --spec-draft-p-min 0) ;;
  dflash2) SPEC=(--spec-type draft-dflash --spec-draft-model "$DFLASH2" --spec-draft-ngl all
                 --spec-draft-n-max ${DEPTH:-7} --spec-draft-p-min 0) ;;
  *) echo "unknown mode $MODE"; exit 2 ;;
esac
# DRAFT_DEV=CUDA0 pins a separate draft model (FastMTP / DFlash2) to one GPU. Under -sm tensor
# the tensor-split meta backend asserts on separate draft models (upstream #28777 / #27833);
# a single-device draft never enters that backend.
[ -n "$DRAFT_DEV" ] && [ ${#SPEC[@]} -gt 0 ] && SPEC+=(--spec-draft-device "$DRAFT_DEV")
SPLITARGS=(--split-mode "$SPLIT" --tensor-split 1,1,1,1)
[ "$SPLIT" = tensor ] && SPLITARGS+=(--fit off)

exec $BIN/llama-server --model "$TARGET" --host 127.0.0.1 --port 5096 \
  --alias "hauhau-$MODE" \
  --n-gpu-layers all "${SPLITARGS[@]}" \
  --ctx-size 294912 --parallel 8 --kv-unified \
  --batch-size 2048 --ubatch-size 512 \
  --flash-attn on --no-mmap \
  --jinja --reasoning-format deepseek \
  --metrics --slots \
  "${SPEC[@]}"
