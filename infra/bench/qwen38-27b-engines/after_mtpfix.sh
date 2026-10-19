#!/bin/bash
# Re-run 1Cat MTP after adding re:^mtp.* to quantization_config.ignore (2026-10-19).
# Without it vLLM treated the BF16 MTP head as INT8-quantized -> 0% draft acceptance.
cd /opt/bench-27b
until grep -q "AFTER_LLAMA DONE" logs/after_llama.log; do sleep 30; done
sleep 20
mv results/1cat-mtp.json results/1cat-mtp-BROKEN-no-mtp-ignore.json 2>/dev/null
mv logs/1cat-mtp.log logs/1cat-mtp-BROKEN-no-mtp-ignore.log 2>/dev/null
echo "=== $(date +%T) 1Cat MTP re-run with fixed ignore list"
MODES=mtp MODEL_DIR=/models/Qwen3.8/27B-Uncensored-HauhauCS-Aggressive/W8A16-Int8-MTP ./chain_1cat.sh > logs/chain_1cat_mtpfix.log 2>&1
echo "=== $(date +%T) MTPFIX DONE"
