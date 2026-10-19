#!/bin/bash
# 1Cat DFlash2 re-run (first attempt picked a cache dir holding only the llama.cpp GGUF).
cd /opt/bench-27b
until grep -q "MTPFIX DONE" logs/after_mtpfix.log; do sleep 30; done
sleep 20
echo "=== $(date +%T) 1Cat DFlash2 re-run"
MODES=dflash2 ./chain_1cat.sh > logs/chain_1cat_dflash.log 2>&1
echo "=== $(date +%T) DFLASH RERUN DONE"
