#!/bin/bash
# ProxLab Provider Installer: Qwen3-TTS (OpenAI-compatible)
# Usage: ./qwen-tts.sh [install|uninstall|status]
#
# Installs pasky/Qwen3-TTS-Openai-Fastapi (FastAPI server speaking the OpenAI
# /v1/audio/* shape), wrapping the upstream qwen_tts library. Two backends:
#
#   official   — pure-PyTorch transformers backend. Simple, ~5 min install.
#   vllm_omni  — vLLM-Omni accelerated. PagedAttention + flash-attn, ~25-40
#                min install (flash-attn compile is the long pole), faster
#                first-audio latency. Requires patches/apply.py to fix two
#                known upstream bugs (dict mutation + voice-clone serialize).
#
# By default we install BOTH so you can pick at launch time via the Backend
# dropdown. Set PROXLAB_INSTALL_VLLM=0 to skip vllm and get the lighter
# install if you don't need the throughput.
#
# Coexists with proxlab-tts (chatterbox) — different conda env, different
# install dir, different default port.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_INSTALL_DIR        - Install directory (default: /opt/qwen-tts)
#   PROXLAB_CONDA_ENV          - Conda env name (default: qwen-tts)
#   PROXLAB_INSTALL_VLLM       - Install vllm + vllm-omni + flash-attn +
#                                apply patches (default: 1). Set to 0 for a
#                                fast install that only ships the official
#                                backend.

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/qwen-tts}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-qwen-tts}"
INSTALL_VLLM="${PROXLAB_INSTALL_VLLM:-1}"

# Pre-downloaded weight cache visible inside AI containers as /tts/models/...
# (zfs flashpool /ai-assets/tts/models bind-mounted in). The serve.sh below
# defaults TTS_MODEL_NAME to a path under here so installs don't re-download.
WEIGHTS_ROOT="/tts/models/Qwen-3-TTS"
DEFAULT_VARIANT="Qwen3-TTS-12Hz-1.7B-Base"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/source/api/main.py" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        # Health check is intentionally aggressive — `import api.main`
        # alone succeeds even on a broken stack because the actual model
        # backend loads lazily on first request. Exercise the
        # transformers + torchvision lazy-import chain that bites at
        # serve time, plus vllm if the user asked for that backend.
        VLLM_CHECK=""
        if [ "$INSTALL_VLLM" = "1" ]; then
            VLLM_CHECK="import vllm; import vllm_omni"
        fi
        if conda run -n "$CONDA_ENV" python3 -c "
import api.main
from transformers import AutoProcessor
import torchvision; torchvision.ops.nms
${VLLM_CHECK}
" 2>/dev/null; then
            echo "Qwen3-TTS already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "Qwen3-TTS version file exists but environment is unhealthy — reinstalling"
        echo "  (likely torch/torchvision mismatch, missing vllm, or upstream patch drift)"
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing Qwen3-TTS (pasky/Qwen3-TTS-Openai-Fastapi + OpenAI-compatible API)..."

    mkdir -p "$INSTALL_DIR"

    # Trust the pytorch-nvidia prereq — it installed torch + torchvision +
    # torchaudio at matched versions (currently torch 2.10.0 / cu128). An
    # earlier version of this script forced torch==2.6.0 cu124 (cribbed
    # from chatterbox's V100 compat) which left torchvision pinned to a
    # newer torch and crashed at "operator torchvision::nms does not
    # exist" the first time transformers tried to import AutoProcessor.
    # Qwen3-TTS doesn't support V100 anyway, so the workaround was wrong.
    #
    # Self-heal a previously-broken install: if torch/torchvision majors
    # disagree, reinstall torch/torchaudio matched to whatever torchvision
    # currently has (we trust torchvision since it was installed by the
    # cu128 prereq and won't be touched by .[api]).
    TORCH_VER=$(conda run -n "$CONDA_ENV" python3 -c \
        "import torch; print(torch.__version__.split('+')[0])" 2>/dev/null || echo "")
    TV_VER=$(conda run -n "$CONDA_ENV" python3 -c \
        "import torchvision; print(torchvision.__version__.split('+')[0])" 2>/dev/null || echo "")
    if [ -n "$TORCH_VER" ] && [ -n "$TV_VER" ]; then
        TORCH_MAJOR_MINOR=$(echo "$TORCH_VER" | cut -d. -f1-2)
        # torchvision N.M tracks torch ((N-1) * 0.5 + 1).M roughly — easier
        # to just check whether nms can register, which is the symptom.
        if ! conda run -n "$CONDA_ENV" python3 -c \
            "import torchvision; torchvision.ops.nms" 2>/dev/null; then
            echo "Detected torch/torchvision mismatch (torch=$TORCH_VER torchvision=$TV_VER) — reinstalling matching cu128 stack"
            conda run -n "$CONDA_ENV" pip install --force-reinstall \
                torch torchaudio torchvision \
                --index-url https://download.pytorch.org/whl/cu128 2>&1
        fi
    fi

    # We use pasky/Qwen3-TTS-Openai-Fastapi — it bundles the upstream
    # qwen_tts package PLUS an OpenAI-compatible api/main.py FastAPI
    # server. The upstream QwenLM/Qwen3-TTS is just the library and
    # ships no HTTP server, so don't clone that one.
    REPO_URL="https://github.com/pasky/Qwen3-TTS-Openai-Fastapi.git"

    # Self-heal: if a previous install pointed at the wrong upstream
    # (e.g. earlier versions of this script cloned QwenLM/Qwen3-TTS),
    # blow it away so the new clone takes effect.
    if [ -d "$INSTALL_DIR/source/.git" ]; then
        EXISTING_URL=$(git -C "$INSTALL_DIR/source" remote get-url origin 2>/dev/null || echo "")
        if [ "$EXISTING_URL" != "$REPO_URL" ]; then
            echo "Existing clone points at: ${EXISTING_URL:-(unknown)}"
            echo "Replacing with: $REPO_URL"
            rm -rf "$INSTALL_DIR/source"
        fi
    fi

    if [ ! -d "$INSTALL_DIR/source/.git" ]; then
        git clone --depth=1 "$REPO_URL" "$INSTALL_DIR/source" 2>&1
    else
        echo "Updating existing clone..."
        git -C "$INSTALL_DIR/source" pull --ff-only 2>&1 || \
            echo "WARN: pull failed (likely local edits) — continuing with current checkout"
    fi

    # Install package — with [vllm] extra if the performance backend was
    # requested. Editable so we can patch in place if needed without
    # reinstall. The patches/apply.py step below applies fixes against
    # vllm-omni's installed site-packages.
    if [ "$INSTALL_VLLM" = "1" ]; then
        echo "Installing [api,vllm] extras (vllm + vllm-omni)..."
        conda run -n "$CONDA_ENV" pip install -e "$INSTALL_DIR/source[api,vllm]" 2>&1
    else
        echo "Installing [api] extra only (skipping vllm — set PROXLAB_INSTALL_VLLM=1 for the perf backend)"
        conda run -n "$CONDA_ENV" pip install -e "$INSTALL_DIR/source[api]" 2>&1
    fi

    # Verify the api module is actually importable — bail early if it's not
    # so we don't write a .version file that masks a broken install.
    if ! conda run -n "$CONDA_ENV" python3 -c "import api.main" 2>/dev/null; then
        echo "ERROR: api.main not importable after install — aborting"
        echo "  Check $INSTALL_DIR/source/api/main.py exists and pip install logs above for errors"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # ffmpeg for opus/mp3/flac encoding (same approach as chatterbox).
    # patch is needed by patches/apply.py below.
    conda install -n "$CONDA_ENV" -y -c conda-forge ffmpeg 2>&1
    if ! command -v patch >/dev/null 2>&1; then
        echo "Installing 'patch' utility (required by patches/apply.py)..."
        apt-get install -y patch 2>&1 || \
            conda install -n "$CONDA_ENV" -y -c conda-forge patch 2>&1
    fi

    # flash-attn is required for the vllm_omni backend (vllm-omni links
    # against it directly). Skip when only official backend is wanted.
    if [ "$INSTALL_VLLM" = "1" ]; then
        # We download the precompiled wheel directly instead of letting
        # `pip install flash-attn` do it. Two reasons:
        #
        # 1. flash-attn's setup.py downloads a matching wheel from its
        #    GitHub releases page when one exists, then tries to move it
        #    into pip's wheel cache via os.rename(). In containers the
        #    build dir (/tmp, tmpfs) and pip cache (/root/.cache, rootfs)
        #    are on different filesystems, so the rename fails with
        #    EXDEV "Invalid cross-device link" and the install dies.
        # 2. Building from source needs nvcc + a long compile (15-30 min
        #    even at MAX_JOBS=4). Prebuilt wheels skip both.
        echo "Resolving matching flash-attn wheel for the installed torch..."
        WHEEL_INFO=$(conda run -n "$CONDA_ENV" python3 -c "
import sys, torch
torch_mm = '.'.join(torch.__version__.split('+')[0].split('.')[:2])
cuda_major = (torch.version.cuda or '').split('.')[0] or 'cpu'
py_tag = f'cp{sys.version_info.major}{sys.version_info.minor}'
cxx = 'TRUE' if torch._C._GLIBCXX_USE_CXX11_ABI else 'FALSE'
print(f'{torch_mm}|{cuda_major}|{py_tag}|{cxx}')
" 2>/dev/null)
        IFS='|' read -r TORCH_MM CUDA_MAJOR PY_TAG CXX_ABI <<< "$WHEEL_INFO"
        FA_VERSION="2.8.3"
        WHEEL_NAME="flash_attn-${FA_VERSION}+cu${CUDA_MAJOR}torch${TORCH_MM}cxx11abi${CXX_ABI}-${PY_TAG}-${PY_TAG}-linux_x86_64.whl"
        WHEEL_URL="https://github.com/Dao-AILab/flash-attention/releases/download/v${FA_VERSION}/${WHEEL_NAME}"
        WHEEL_PATH="/tmp/${WHEEL_NAME}"
        echo "Downloading: $WHEEL_NAME"
        if ! curl -fsSL -o "$WHEEL_PATH" "$WHEEL_URL"; then
            echo "ERROR: failed to download $WHEEL_URL"
            echo "  Check https://github.com/Dao-AILab/flash-attention/releases for a wheel matching:"
            echo "  torch=${TORCH_MM} cuda=${CUDA_MAJOR} python=${PY_TAG} cxx11abi=${CXX_ABI}"
            echo "PROXLAB_STATUS=error"
            exit 1
        fi
        echo "Installing flash-attn from local wheel..."
        conda run -n "$CONDA_ENV" pip install "$WHEEL_PATH" 2>&1
        rm -f "$WHEEL_PATH"
    else
        echo "Skipping flash-attn install (only needed when vllm_omni backend is enabled)"
    fi

    # Apply pasky's patches against the installed vllm/vllm-omni — fixes
    # two upstream bugs (dict mutation in Qwen3TTSModelForGeneration.forward,
    # msgpack serialization of voice-clone flattened keys). Idempotent — the
    # script reverse-dry-runs each patch before applying. Skip if vllm
    # backend isn't installed since the patches target vllm-omni internals.
    if [ "$INSTALL_VLLM" = "1" ] && [ -f "$INSTALL_DIR/source/patches/apply.py" ]; then
        echo "Applying vllm-omni patches..."
        if ! conda run -n "$CONDA_ENV" python3 "$INSTALL_DIR/source/patches/apply.py" 2>&1; then
            echo "WARN: patches/apply.py reported an error — vllm_omni backend may have known bugs at runtime"
            echo "      The official backend will still work. Continuing."
        fi
    fi

    # Confirm pre-downloaded weights are visible. We don't fail if absent —
    # the user might be running on a node without the bind mount yet — but
    # we DO warn so they don't get a surprise auto-download from HF.
    if [ -d "$WEIGHTS_ROOT/$DEFAULT_VARIANT" ]; then
        echo "Detected local weights at $WEIGHTS_ROOT/$DEFAULT_VARIANT — auto-download will be skipped at launch"
    else
        echo "WARN: $WEIGHTS_ROOT/$DEFAULT_VARIANT not found"
        echo "      Mount /ai-assets/tts/models into the container as /tts/models, or expect HF auto-download on first launch"
    fi

    # Launcher script — keeps the launch interface stable even if the
    # upstream entry point evolves. ProxLab's TTS_LAUNCH_TEMPLATES calls
    # this with --port and optional --variant.
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# Qwen3-TTS server launcher.
# Usage: ./serve.sh [--port 8881] [--variant Qwen3-TTS-12Hz-1.7B-Base] [--backend official|vllm_omni]
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/qwen-tts}"
WEIGHTS_ROOT="/tts/models/Qwen-3-TTS"

PORT="${PORT:-8881}"
VARIANT="${TTS_VARIANT:-Qwen3-TTS-12Hz-1.7B-Base}"
BACKEND="${TTS_BACKEND:-official}"
HOST="${HOST:-0.0.0.0}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)    PORT="$2"; shift 2;;
        --variant) VARIANT="$2"; shift 2;;
        --backend) BACKEND="$2"; shift 2;;
        --host)    HOST="$2"; shift 2;;
        *) echo "Unknown arg: $1"; exit 1;;
    esac
done

# Resolve model path: prefer local directory, fall back to HF repo name so
# the upstream code can auto-download (and warn so the user notices).
LOCAL_PATH="$WEIGHTS_ROOT/$VARIANT"
if [ -d "$LOCAL_PATH" ]; then
    MODEL_NAME="$LOCAL_PATH"
else
    echo "WARN: $LOCAL_PATH not found locally — falling back to HF auto-download"
    MODEL_NAME="Qwen/$VARIANT"
fi

export TTS_BACKEND="$BACKEND"
export TTS_MODEL_NAME="$MODEL_NAME"
export HOST="$HOST"
export PORT="$PORT"

cd "$INSTALL_DIR/source"
exec /opt/conda/envs/qwen-tts/bin/python -m api.main
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    # Record version (commit sha — there's no semver tag yet).
    VER=$(git -C "$INSTALL_DIR/source" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    echo "Qwen3-TTS installed: $VER"
    echo "Launch:  $INSTALL_DIR/serve.sh --port 8881"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    echo "Removing Qwen3-TTS..."
    rm -rf "$INSTALL_DIR"
    if conda env list | awk '{print $1}' | grep -qx "$CONDA_ENV"; then
        conda env remove -n "$CONDA_ENV" -y 2>&1
    fi
    echo "PROXLAB_STATUS=uninstalled"
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/source/api/main.py" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$VER"
    else
        echo "PROXLAB_STATUS=not_installed"
    fi
}

case "$ACTION" in
    install)   do_install;;
    uninstall) do_uninstall;;
    status)    do_status;;
    *) echo "Usage: $0 [install|uninstall|status]"; exit 1;;
esac
