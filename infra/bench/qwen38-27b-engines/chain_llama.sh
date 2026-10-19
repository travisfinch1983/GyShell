#!/bin/bash
# Unattended llama.cpp battery: base -> mtp -> dflash2 -> fastmtp (TP4, GPUs 8a-8d).
# Production 1cat-vllm-5003 must be suspended (Travis OK'd taking it down for testing).
cd /opt/bench-27b
PY=/opt/conda/envs/llmc/bin/python
EXTRA="$*"                                   # e.g. --quick
ready() {
  for i in $(seq 1 180); do
    curl -sf -m 3 http://127.0.0.1:5096/v1/models >/dev/null && return 0
    kill -0 $1 2>/dev/null || return 1
    sleep 5
  done; return 1
}
gen_ok() {   # a real token, not /health (health can be 200 on a dead engine)
  curl -sf -m 300 http://127.0.0.1:5096/v1/chat/completions -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"Capital of France? One word."}],"max_tokens":200,"temperature":0}' \
    | python3 -c "import sys,json;r=json.load(sys.stdin);m=r['choices'][0]['message'];print('GEN:',repr((m.get('content') or '')[-40:]),'| think chars',len(m.get('reasoning_content') or ''))"
}
stop() { kill -TERM -- -$1 2>/dev/null; sleep 10; kill -KILL -- -$1 2>/dev/null; sleep 5; }
run_mode() {   # mode split
  local mode=$1 split=$2 tag="$1-$2" log="logs/llama-$1-$2.log"
  echo "=== $(date +%T) $tag"
  setsid ./launch_llama.sh $mode $split > $log 2>&1 < /dev/null &
  local pg=$!
  if ! ready $pg; then echo "$tag: server failed to start"; tail -4 $log | cut -c1-220; stop $pg; return 1; fi
  gen_ok || { echo "$tag: generation failed"; stop $pg; return 1; }
  echo "spec signals:"; grep -E "adding speculative implementation|creating MTP draft|common_speculative_init|draft-dflash|d2t draft-vocab|n_max=|dflash" $log | sort -u | head -6 | cut -c1-200
  $PY bench27.py 5096 llama-$tag results/llama-$tag.json $EXTRA
  echo "acceptance (server log):"; grep -E "draft acceptance|accept" $log | tail -3 | cut -c1-200
  stop $pg; return 0
}
# Full battery (2026-10-18 smoke: DFlash2 asserts under -sm tensor = upstream #28777, so it runs
# layer-split, with a layer-split baseline as its like-for-like control).
CONFIGS=${CONFIGS:-"base:tensor mtp:tensor fastmtp:tensor base:layer dflash2:layer"}
for c in $CONFIGS; do
  run_mode ${c%%:*} ${c##*:} || echo "CONFIG FAILED: $c"
done
echo "=== $(date +%T) LLAMA CHAIN DONE"
