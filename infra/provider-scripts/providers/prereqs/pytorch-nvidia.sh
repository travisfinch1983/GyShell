#!/bin/bash
# ProxLab: PyTorch Install (NVIDIA)
# Architecture-aware PyTorch installation with appropriate CUDA version.
#
# NOTE: vLLM will upgrade PyTorch to its own pinned version, so this step
# primarily ensures a working torch+CUDA base. The provider install script
# handles the final version.
#
# Environment:
#   PROXLAB_GPU_ARCHS - GPU architectures

set -euo pipefail

ARCHS="${PROXLAB_GPU_ARCHS:-}"

echo "PyTorch + CUDA setup..."

# Ensure conda is available
export PATH="/opt/conda/bin:$PATH"
if ! command -v conda &>/dev/null; then
    echo "ERROR: conda not found — install-conda.sh must run first"
    exit 1
fi

# ─── Determine CUDA version + torch pin ───────────────────────────────────
#
# Volta (V100, SM 7.0) was dropped by PyTorch 2.5+: the cu128 / cu126 wheels
# bundle cuDNN 9.x which has no SM <7.5 kernel images, and the torch arch
# list excludes 7.0. Symptoms: "Found GPU0 Tesla V100 ... compute capability
# (CC) 7.0" + "cuDNN version 91900 is not compatible with devices with SM
# < 7.5". The last torch release that still ships Volta-capable kernels and
# cuDNN 8.x is 2.4.1 + cu124.
#
# Strategy:
#   - If GPU arch list contains Volta → pin torch==2.4.1 + cu124 (cuDNN 8.x)
#   - Otherwise → cu128 latest (Ampere/Ada/Hopper/Blackwell)
#
# ARCHS comes from gpu-monitor's classification (e.g. "Ampere,Ada" or "Volta").

if echo "${ARCHS}" | grep -qiE 'volta|sm_?70|7\.0'; then
    CUDA_TAG="cu124"
    TORCH_PIN="torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1"
    VOLTA_MODE=1
else
    CUDA_TAG="cu128"
    TORCH_PIN="torch torchvision torchaudio"
    VOLTA_MODE=0
fi

echo "GPU architectures: ${ARCHS:-unknown}"
echo "Selected PyTorch CUDA tag: ${CUDA_TAG}"
[ "$VOLTA_MODE" = "1" ] && echo "Volta detected — pinning torch 2.4.1 (last with cuDNN 8 + SM 7.0 support)"

# ─── Check / Create conda environment ──────────────────────────────────────

CONDA_ENV="${PROXLAB_CONDA_ENV:-base}"
PYTHON_VER="${PROXLAB_PYTHON_VERSION:-3.12}"

if [ "$CONDA_ENV" != "base" ]; then
    if ! conda env list 2>/dev/null | grep -qw "^${CONDA_ENV} "; then
        echo "Creating conda environment: $CONDA_ENV (Python ${PYTHON_VER})..."
        conda create -n "$CONDA_ENV" python="$PYTHON_VER" -y 2>&1
    else
        echo "Conda environment '$CONDA_ENV' already exists"
    fi
fi

# ─── Check existing PyTorch ────────────────────────────────────────────────
#
# `torch.cuda.is_available()` returns True even when the GPU's SM is missing
# from torch's arch list — it'll only crash at kernel launch. Verify the
# detected SM is actually in `torch.cuda.get_arch_list()`; if not, reinstall.

if conda run -n "$CONDA_ENV" python3 -c "import torch" 2>/dev/null; then
    SM_OK=$(conda run -n "$CONDA_ENV" python3 -c "
import torch
if not torch.cuda.is_available():
    print('NO_CUDA'); raise SystemExit
maj, minr = torch.cuda.get_device_capability(0)
sm_tag = f'sm_{maj}{minr}'
arches = torch.cuda.get_arch_list()
print('OK' if any(sm_tag == a or sm_tag + 'a' == a for a in arches) else f'MISSING:{sm_tag}:{\",\".join(arches)}')
" 2>/dev/null || echo "ERR")
    case "$SM_OK" in
        OK)
            echo "PyTorch with CUDA already installed and arch-compatible"
            exit 0
            ;;
        NO_CUDA)
            echo "PyTorch installed but CUDA not available — reinstalling"
            ;;
        MISSING:*)
            echo "PyTorch installed but missing this GPU's arch: $SM_OK"
            echo "  Reinstalling with arch-correct wheel..."
            conda run -n "$CONDA_ENV" pip uninstall -y torch torchvision torchaudio 2>&1 || true
            ;;
        *)
            echo "PyTorch arch check failed ($SM_OK) — reinstalling"
            ;;
    esac
fi

# ─── Install PyTorch ──────────────────────────────────────────────────────

echo "Installing PyTorch with CUDA (${CUDA_TAG})..."

conda run -n "$CONDA_ENV" pip install $TORCH_PIN \
    --index-url "https://download.pytorch.org/whl/${CUDA_TAG}"

# ─── Verify ───────────────────────────────────────────────────────────────

TORCH_VER=$(conda run -n "$CONDA_ENV" python3 -c "import torch; print(torch.__version__)" 2>/dev/null || echo "unknown")
CUDA_AVAIL=$(conda run -n "$CONDA_ENV" python3 -c "import torch; print(torch.cuda.is_available())" 2>/dev/null || echo "False")

echo "PyTorch version: $TORCH_VER"
echo "CUDA available: $CUDA_AVAIL"

if [ "$CUDA_AVAIL" != "True" ]; then
    echo "WARNING: CUDA not available in PyTorch — GPU may not be visible"
fi
