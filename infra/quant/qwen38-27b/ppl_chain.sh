#!/bin/bash
# Paired-perplexity legs on V100 8a-8d (TP4), production 27B suspended (Travis OK'd, 2026-10-18).
# Each leg: own process group via setsid, scored, then the WHOLE group killed by its pgid.
export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=0,1,2,3
export PATH="/opt/conda/envs/1cat-vllm-sm70-150/bin:$PATH" CUDA_HOME=/opt/conda/envs/1cat-vllm-sm70-150
export VLLM_DISABLED_KERNELS=MarlinLinearKernel VLLM_SM70_QUANT_BACKEND=turbomind VLLM_SM70_QWEN_GDN_FULL_FORWARD=1
cd /root
leg() {  # name model_dir
  local name=$1 dir=$2
  echo "=== $(date +%T) leg $name: $dir"
  setsid /opt/conda/envs/1cat-vllm-sm70-150/bin/vllm serve "$dir" --port 5097 --host 127.0.0.1 \
    --tensor-parallel-size 4 --max-model-len 16384 --max-num-seqs 2 --gpu-memory-utilization 0.85 \
    --dtype half --no-enable-prefix-caching --served-model-name "ppl-$name" \
    --attention-backend FLASH_ATTN_V100 --mamba-cache-mode all \
    > "/root/ppl_server_$name.log" 2>&1 < /dev/null &
  local pg=$!
  for i in $(seq 1 120); do
    curl -sf -m 3 http://127.0.0.1:5097/v1/models >/dev/null && break
    kill -0 $pg 2>/dev/null || { echo "leg $name: server died"; tail -5 "/root/ppl_server_$name.log"; return 1; }
    sleep 10
  done
  python3 /root/ppl_score.py 5097 "/root/ppl_$name.json"
  kill -TERM -- -$pg; sleep 15; kill -KILL -- -$pg 2>/dev/null; sleep 10
}
leg stockbf16 /models/Qwen3.8/27B/BF16-Safetensors
leg prod      /model-cache/Qwen3.8/27B-INT8-W8A16-MTP
leg prodfix   /root/prodfix
leg uncbf16   /models/Qwen3.8/27B-Uncensored/BF16-Safetensors
leg uncw8     /root/q38unc-out
echo "=== $(date +%T) COMPARE"
python3 /root/ppl_score.py --compare /root/ppl_stockbf16.json /root/ppl_prod.json /root/ppl_prodfix.json
python3 /root/ppl_score.py --compare /root/ppl_uncbf16.json /root/ppl_uncw8.json
echo "=== $(date +%T) CHAIN DONE"
