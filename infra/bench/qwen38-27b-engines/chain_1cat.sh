#!/bin/bash
# 1Cat battery on the converted HauhauCS W8A16: nospec -> mtp -> dflash2 (production 5003 flags).
# Same bench27.py, same seeded prompt sequence as the llama.cpp battery.
cd /opt/bench-27b
PY=/opt/conda/envs/llmc/bin/python
MODEL_DIR=${MODEL_DIR:-/model-cache/Qwen3.8/27B-Uncensored-HauhauCS-Aggressive/W8A16-Int8-MTP}
MODES=${MODES:-"nospec mtp dflash2"}
EXTRA="$*"
ready() {
  for i in $(seq 1 240); do
    curl -sf -m 3 http://127.0.0.1:5095/v1/models >/dev/null && return 0
    kill -0 $1 2>/dev/null || return 1
    sleep 5
  done; return 1
}
gen_ok() {
  curl -sf -m 300 http://127.0.0.1:5095/v1/chat/completions -H 'Content-Type: application/json' \
    -d '{"model":"bench-1cat","messages":[{"role":"user","content":"Capital of France? One word."}],"max_tokens":200,"temperature":0}' \
    | python3 -c "import sys,json;r=json.load(sys.stdin);m=r['choices'][0]['message'];print('GEN:',repr((m.get('content') or '')[-40:]),'| think chars',len(m.get('reasoning_content') or m.get('reasoning') or ''))"
}
stop() { kill -TERM -- -$1 2>/dev/null; sleep 20; kill -KILL -- -$1 2>/dev/null; sleep 10; }
for mode in $MODES; do
  log=logs/1cat-$mode.log
  echo "=== $(date +%T) 1cat-$mode ($MODEL_DIR)"
  setsid ./launch_1cat.sh $mode "$MODEL_DIR" > $log 2>&1 < /dev/null &
  pg=$!
  if ! ready $pg; then echo "1cat-$mode: server failed to start"; grep -E "Error|error" $log | tail -3 | cut -c1-220; stop $pg; continue; fi
  gen_ok || { echo "1cat-$mode: generation failed"; stop $pg; continue; }
  echo "spec signals:"; grep -E "Detected MTP|DFlash2|speculat" $log | sort -u | head -4 | cut -c1-200
  $PY bench27.py 5095 1cat-$mode results/1cat-$mode.json $EXTRA
  echo "acceptance (server log):"; grep "SpecDecoding metrics" $log | tail -2 | cut -c1-230
  stop $pg
done
echo "=== $(date +%T) 1CAT CHAIN DONE"
