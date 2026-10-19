#!/bin/bash
# Waits for the llama.cpp battery, then runs the 1Cat battery and the HauhauCS perplexity legs
# back-to-back on GPUs 8a-8d. Production stays suspended until claude1 resumes it.
cd /opt/bench-27b
until grep -q "LLAMA CHAIN DONE" logs/chain_llama_full.log; do sleep 30; done
sleep 20
ps -eo pid,args | awk '/[l]lama-server --model/ {print "WARNING leftover llama-server", $1}'
echo "=== $(date +%T) starting 1Cat battery"
./chain_1cat.sh > logs/chain_1cat.log 2>&1
echo "=== $(date +%T) starting HauhauCS perplexity legs"
/root/ppl_chain_hauhau.sh > logs/ppl_hauhau.log 2>&1
echo "=== $(date +%T) AFTER_LLAMA DONE"
