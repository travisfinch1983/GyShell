#!/bin/bash
# claude1 2026-11-03: RMBG-2.0 cutout -> Hunyuan3D-2.1 shape+texture -> preview, per photo, on the ai-epyc 4090.
# Usage: ailab-batch.sh <photo.jpg>...   outputs /imagegen/3d-tests/hunyuan21/<photo-stem>/
export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=4
P=/opt/conda/envs/hunyuan3d21/bin/python; H=/opt/hunyuan3d21; OUT=/imagegen/3d-tests/hunyuan21
for f in "$@"; do
  n=$(basename "$f" .jpg); o=$OUT/$n; mkdir -p "$o"
  echo "=== $n start $(date +%T)"
  $P $H/ailab-rmbg.py "$f" "$o/cutout.png" 2>&1 | grep -v pthread_setaffinity | tail -1
  $P $H/ailab-run.py "$o/cutout.png" "$o" > "$o/run.log" 2>&1 && echo "$n run OK" || { echo "$n run FAILED"; tail -5 "$o/run.log"; continue; }
  $P $H/ailab-preview.py "$o" > "$o/preview.log" 2>&1 && echo "$n preview OK" || echo "$n preview FAILED"
  echo "=== $n done $(date +%T)"
done
echo BATCH-DONE
