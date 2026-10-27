#!/usr/bin/env bash
# Re-apply CUDA machine learning after a community-scripts Immich update (claude1, 2026-10-27).
# The updater only knows cpu/openvino: it reinstalls onnxruntime / onnxruntime-openvino into the
# ML venv every time, silently dropping our onnxruntime-gpu (RTX 5060, CUDA 13 libs from the local
# store — see the immich CUDA notes). Run this after EVERY `update`.
set -euo pipefail
V=/opt/immich/app/machine-learning/ml-venv
UV=/usr/local/bin/uv            # not on PATH under pct exec
ORT_GPU="onnxruntime-gpu==1.28.0"   # 1.28 = CUDA 13 build; upstream pins <1.28 (CUDA 12)

for pkg in onnxruntime-openvino onnxruntime; do
  if "$UV" pip show --python "$V/bin/python" "$pkg" >/dev/null 2>&1; then
    VIRTUAL_ENV=$V "$UV" pip uninstall --python "$V/bin/python" "$pkg"
  fi
done
VIRTUAL_ENV=$V "$UV" pip install --python "$V/bin/python" "$ORT_GPU"

# Verify on get_providers(), never on results: ORT falls back to CPU silently and still answers.
"$V/bin/python" - <<'PY'
import glob, onnxruntime as ort
m = sorted(glob.glob("/opt/immich/cache/clip/**/model.onnx", recursive=True))[0]
s = ort.InferenceSession(m, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
assert s.get_providers()[0] == "CUDAExecutionProvider", f"CPU FALLBACK: {s.get_providers()}"
print("CUDA OK:", ort.__version__, m)
PY
systemctl restart immich-ml
echo "immich-ml restarted on CUDA"
