#!/bin/bash
# ProxLab Provider Installer: Fish-Audio S2-Pro (OpenAI-compatible)
# Usage: ./s2-pro.sh [install|uninstall|status]
#
# Installs sglang-omni (the official streaming engine for Fish-Audio
# S2-Pro) with an OpenAI-compatible /v1/audio/speech endpoint.
#
# S2-Pro is a 5B-parameter multilingual TTS with inline tag control
# (`[whisper]`, `[excited]`, `[laughing]`, etc — 15,000+ free-form
# tags), zero-shot voice cloning via reference clips, and ~100ms
# time-to-first-audio. License: Fish Audio Research License
# (non-commercial / personal use only — flagged in the provider card).
#
# Coexists with proxlab-tts (chatterbox) and qwen-tts — different
# conda env, different install dir, default port 8882.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_INSTALL_DIR  - Install directory (default: /opt/s2-pro)
#   PROXLAB_CONDA_ENV    - Conda env name (default: s2-pro)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/s2-pro}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-s2-pro}"

# Pre-downloaded weights — Safetensors form (codec.pth + sharded
# model + tokenizer). The GGUF variants in /tts/models/Fish-Audio/
# S2-Pro-GGUF are for llama.cpp-style serving, which sglang-omni
# doesn't use, so we point only at the safetensors set here.
WEIGHTS_PATH="/tts/models/Fish-Audio/S2-Pro-Safetensors"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Real health check — sglang_omni importable + serve script present.
    # `import api.main`-style early-exit isn't enough for the same reason
    # qwen-tts learned the hard way: the full lazy-import chain only
    # bites at serve time.
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/serve.sh" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import sglang_omni" 2>/dev/null; then
            echo "Fish-Audio S2-Pro already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "S2-Pro version file exists but sglang_omni not importable — reinstalling"
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing Fish-Audio S2-Pro (sglang-omni + OpenAI-compatible API)..."

    mkdir -p "$INSTALL_DIR"

    # System libs sglang-omni needs at runtime (audio I/O). ffmpeg
    # likely already installed from chatterbox; libsox-dev and
    # portaudio19-dev usually aren't.
    apt-get install -y --no-install-recommends \
        libsox-dev portaudio19-dev 2>&1 || \
        echo "WARN: apt install failed for libsox/portaudio — sglang-omni may complain at startup"

    # Clone sglang-omni — the official S2-Pro serving engine.
    REPO_URL="https://github.com/sgl-project/sglang-omni.git"
    if [ -d "$INSTALL_DIR/source/.git" ]; then
        EXISTING_URL=$(git -C "$INSTALL_DIR/source" remote get-url origin 2>/dev/null || echo "")
        if [ "$EXISTING_URL" != "$REPO_URL" ]; then
            echo "Existing clone points at $EXISTING_URL — replacing with $REPO_URL"
            rm -rf "$INSTALL_DIR/source"
        fi
    fi
    if [ ! -d "$INSTALL_DIR/source/.git" ]; then
        git clone --depth=1 "$REPO_URL" "$INSTALL_DIR/source" 2>&1
    else
        echo "Updating existing clone..."
        git -C "$INSTALL_DIR/source" pull --ff-only 2>&1 || \
            echo "WARN: pull failed — continuing with current checkout"
    fi

    # sglang-omni's pyproject.toml uses a uv-only feature
    # ([tool.uv] override-dependencies) to force a compatible protobuf
    # version against sglang's transitive deps. Plain pip ignores
    # this and bombs with "sglang and sglang-omni have conflicting
    # dependencies". Use uv inside the conda env so the override
    # actually takes effect.
    echo "Installing uv into the conda env (sglang-omni requires uv-resolver overrides)..."
    conda run -n "$CONDA_ENV" pip install -U uv 2>&1

    # The [tool.uv] override-dependencies block in their pyproject is
    # ONLY consulted by `uv sync`, not by `uv pip install`. For pip-
    # install mode we have to pass an --override constraints file
    # ourselves. Without it, uv reports the same protobuf range
    # conflict pip did:
    #   sglang 0.5.8 → grpcio-tools 1.75.1 → protobuf >=6.31.1,<7
    #   descript-audiotools (any) → protobuf >=3.9.2,<3.20
    # Mirror upstream's own [tool.uv] override (force protobuf 6.x);
    # they ship that override knowing descript-audiotools works at
    # runtime against protobuf 6 despite its older metadata.
    OVERRIDE_FILE="/tmp/s2pro-override-$$.txt"
    cat > "$OVERRIDE_FILE" << 'OVERRIDE_EOF'
protobuf>=6.31.1,<7.0.0
OVERRIDE_EOF

    echo "Installing sglang-omni via uv with protobuf override..."
    conda run -n "$CONDA_ENV" uv pip install \
        --override "$OVERRIDE_FILE" \
        -e "$INSTALL_DIR/source" 2>&1
    rm -f "$OVERRIDE_FILE"

    # flash-attn — sglang-omni's pyproject explicitly defers this
    # ("flash-attn: install separately via prebuilt wheel"). Use the
    # same prebuilt-wheel approach as qwen-tts: detect torch / cuda /
    # python / cxx11abi from the env and pull the matching release
    # wheel from GitHub (avoids a 30-min compile and the source-build
    # cross-device-link bug pip hits in containers).
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
    if curl -fsSL -o "$WHEEL_PATH" "$WHEEL_URL"; then
        conda run -n "$CONDA_ENV" pip install "$WHEEL_PATH" 2>&1
        rm -f "$WHEEL_PATH"
    else
        echo "WARN: flash-attn wheel download failed for torch=${TORCH_MM} cuda=${CUDA_MAJOR}"
        echo "      Server may run on the slower SDPA fallback. Check"
        echo "      https://github.com/Dao-AILab/flash-attention/releases"
        echo "      for a wheel matching your torch/cuda combo."
    fi

    # Verify imports — fail loudly instead of writing .version on a
    # broken install.
    if ! conda run -n "$CONDA_ENV" python3 -c "import sglang_omni; import sglang" 2>/dev/null; then
        echo "ERROR: sglang_omni or sglang not importable after install"
        echo "  Check uv pip install logs above for resolver errors"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # ffmpeg from conda-forge as a safety net for opus/mp3/flac
    # encoding (chatterbox installs this too — idempotent here).
    conda install -n "$CONDA_ENV" -y -c conda-forge ffmpeg 2>&1 || true

    # Patch factory.py's attention backend selection. Two issues:
    #
    # 1. The upstream default is `attention_backend = "fa3"` — fa3 calls
    #    into sgl-kernel's prebuilt flash_ops.abi3.so, which only ships
    #    sm_80/sm_86/sm_90a cubins (no PTX, no sm_89, no sm_120). On
    #    any non-Hopper consumer GPU, CUDA graph capture dies with
    #    "no kernel image is available for execution on the device".
    #
    # 2. The upstream guard `if server_args.attention_backend is None`
    #    is dead code — by the time factory.py runs, sglang's
    #    ServerArgs.__post_init__ has already auto-picked "flashinfer"
    #    or similar based on hardware. So replacing "fa3" with "fa2"
    #    isn't enough; we need to UNCONDITIONALLY honor the
    #    S2PRO_ATTENTION_BACKEND env var (set by serve.sh after
    #    GPU auto-detect).
    #
    # Replace the whole `if None: = "fa3"` block with an env-driven
    # override. fa2 (prebuilt flash-attn 2.8.3 wheel) ships
    # sm_80/sm_90/sm_100/sm_120; serve.sh picks "triton" for sm_89
    # (4090) and other arches the wheel misses.
    FACTORY_PY="$INSTALL_DIR/source/sglang_omni/models/fishaudio_s2_pro/factory.py"
    if [ -f "$FACTORY_PY" ] && grep -q 'attention_backend = "fa3"' "$FACTORY_PY"; then
        echo "Patching factory.py: force attention_backend from S2PRO_ATTENTION_BACKEND env"
        /opt/conda/envs/s2-pro/bin/python3 - "$FACTORY_PY" << 'PYEOF'
import sys, re
path = sys.argv[1]
with open(path) as f:
    src = f.read()
old = '''    if server_args.attention_backend is None:
        server_args.attention_backend = "fa3"'''
new = '''    # Patched by ProxLab installer: force backend from
    # S2PRO_ATTENTION_BACKEND env (set by serve.sh based on the visible
    # GPU's compute cap), unconditionally overriding sglang's
    # __post_init__ auto-pick.
    import os as _trkr_os
    _trkr_backend = _trkr_os.environ.get("S2PRO_ATTENTION_BACKEND")
    if _trkr_backend:
        server_args.attention_backend = _trkr_backend
    elif server_args.attention_backend is None:
        server_args.attention_backend = "fa2"'''
if old in src:
    src = src.replace(old, new)
    with open(path, 'w') as f:
        f.write(src)
    print('  patched')
else:
    print('  pattern not found — skipping (already patched?)')
PYEOF
    fi

    # ninja is needed at runtime by flashinfer's JIT compiler when it
    # builds attention kernels during CUDA graph capture. The pip
    # ninja package drops a binary into the env's bin/. Pin
    # explicitly so we don't rely on it sneaking in transitively.
    conda run -n "$CONDA_ENV" pip install -U ninja 2>&1 || true

    # nvcc + cuda headers + cuda dev libs + a host C++ compiler +
    # matched sysroot, all in the env. flashinfer JIT-compiles CUDA
    # source at first launch via nvcc, and four things bite us on stock
    # Debian 13 / Ubuntu 24.04 containers:
    #
    # 1. The gpu-libs/nvidia prereq can't install the system CUDA
    #    toolkit (NVIDIA repo signature rejection), so /usr/local/cuda
    #    has no nvcc.
    # 2. nvcc invokes the host gcc, which on Debian 13 is too new —
    #    its glibc (≥2.36) adds `noexcept` to sinpi/cospi, conflicting
    #    with CUDA 12.8's math_functions.h. Compile dies with
    #    "exception specification is incompatible with that of
    #    previous function 'cospi'".
    # 3. nvcc resolves system headers from /usr/include, picking up
    #    the same incompatible glibc declarations.
    # 4. flashinfer's generated ninja build files link against
    #    -lcudart / -lcublas / -lcusolver. The runtime stubs that ship
    #    with pytorch are .so.N (not the unversioned dev .so the linker
    #    wants), so without dev libs in the env, ld bombs with
    #    "cannot find -lcudart".
    #
    # Fix: install the whole toolchain into the env from conda-forge.
    # cuda-nvcc/cccl give us nvcc + CUDA C++ headers, cuda-libraries-dev
    # ships the unversioned .so symlinks linker resolution needs,
    # gxx_linux-64=12 gives us a host compiler that matches CUDA 12.8's
    # expectations, sysroot_linux-64=2.17 ships compatible glibc headers
    # nvcc finds before the system ones. Match torch's CUDA major (cu128).
    echo "Installing nvcc 12.8 + cuda dev libs + host gcc-12 + sysroot from conda-forge..."
    conda install -n "$CONDA_ENV" -y -c conda-forge \
        "cuda-nvcc=12.8.*" "cuda-cccl=12.8.*" "cuda-libraries-dev=12.8.*" \
        "gxx_linux-64=12" "sysroot_linux-64=2.17" 2>&1 || \
        echo "WARN: toolchain install failed — flashinfer will fail to JIT kernels at first launch"

    # flashinfer's generated ninja files emit `-L$cuda_home/lib64`,
    # but conda installs CUDA libraries to `lib/` (no lib64). Symlink
    # so ld can resolve -lcudart / -lcublas / -lcusolver. Without this,
    # link step bombs with "cannot find -lcudart" even after
    # cuda-libraries-dev is installed.
    if [ ! -e "/opt/conda/envs/$CONDA_ENV/lib64" ]; then
        ln -sfn lib "/opt/conda/envs/$CONDA_ENV/lib64"
        echo "Created /opt/conda/envs/$CONDA_ENV/lib64 → lib (flashinfer ld -L path)"
    fi

    # flashinfer hard-codes `/usr/local/cuda/bin/nvcc` into the ninja
    # build files it generates at module-import time. Even with
    # CUDA_HOME set to the conda env, those cached build scripts
    # call the absolute path directly. Make the path actually exist
    # by symlinking to the conda env. If a stub /usr/local/cuda
    # directory is in the way (typical on cluster containers — left
    # over from incomplete system CUDA installs), move it aside.
    if [ -L /usr/local/cuda ]; then
        # Already a symlink — replace if it points elsewhere
        if [ "$(readlink /usr/local/cuda)" != "/opt/conda/envs/$CONDA_ENV" ]; then
            ln -sfn "/opt/conda/envs/$CONDA_ENV" /usr/local/cuda
        fi
    elif [ -d /usr/local/cuda ]; then
        # Stub directory present. Replace only if it has no bin/nvcc
        # (a real toolkit install we'd want to leave alone).
        if [ ! -e /usr/local/cuda/bin/nvcc ]; then
            mv /usr/local/cuda /usr/local/cuda.empty-stub.$(date +%s)
            ln -sfn "/opt/conda/envs/$CONDA_ENV" /usr/local/cuda
        else
            echo "INFO: real CUDA toolkit at /usr/local/cuda — leaving alone"
        fi
    else
        ln -sfn "/opt/conda/envs/$CONDA_ENV" /usr/local/cuda
    fi
    echo "/usr/local/cuda → $(readlink -f /usr/local/cuda)"

    # Clear any stale flashinfer JIT cache that was generated before
    # the nvcc fix — its ninja files have the wrong absolute path.
    # New cache will regenerate on first launch.
    rm -rf /root/.cache/flashinfer 2>/dev/null || true

    # Confirm pre-downloaded weights are visible. Don't fail if absent
    # (might be running on a node without the bind mount yet) but warn
    # so the user notices instead of getting a surprise HF download.
    if [ -d "$WEIGHTS_PATH" ] && [ -f "$WEIGHTS_PATH/model.safetensors.index.json" ]; then
        echo "Detected local weights at $WEIGHTS_PATH"

        # Backfill any missing tokenizer / config files. The user's
        # pre-downloaded set has the multi-GB safetensors + codec.pth
        # but is missing the small-but-required text/config files
        # (tokenizer.json especially — without it, sgl-omni serve
        # crashes at PreTrainedTokenizerFast.from_pretrained with
        # "Converting from SentencePiece and Tiktoken failed"). Pull
        # only the small files so we don't re-download ~10GB of
        # weights that are already on disk.
        REQUIRED_AUX=("tokenizer.json" "tokenizer_config.json" "config.json" "chat_template.jinja")
        MISSING=()
        for f in "${REQUIRED_AUX[@]}"; do
            if [ ! -f "$WEIGHTS_PATH/$f" ]; then MISSING+=("$f"); fi
        done
        if [ "${#MISSING[@]}" -gt 0 ]; then
            echo "Tokenizer/config files missing — fetching from HuggingFace: ${MISSING[*]}"
            for f in "${MISSING[@]}"; do
                URL="https://huggingface.co/fishaudio/s2-pro/resolve/main/$f"
                if curl -fsSL --retry 3 --retry-delay 2 -o "$WEIGHTS_PATH/$f.tmp" "$URL"; then
                    mv "$WEIGHTS_PATH/$f.tmp" "$WEIGHTS_PATH/$f"
                    echo "  + $f"
                else
                    rm -f "$WEIGHTS_PATH/$f.tmp"
                    echo "  ! failed to fetch $f from $URL"
                fi
            done
        else
            echo "All tokenizer/config files present"
        fi
    else
        echo "WARN: $WEIGHTS_PATH not found or incomplete"
        echo "      Mount /ai-assets/tts/models into the container as /tts/models, or expect HF auto-download on first launch"
    fi

    # Launcher script — keeps the launch contract stable even if
    # upstream sglang-omni's CLI evolves. ProxLab's TTS_LAUNCH_TEMPLATES
    # calls this with --port (and optional --model-path override).
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# Fish-Audio S2-Pro server launcher.
# Usage: ./serve.sh [--port 8882] [--model-path <override>]
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/s2-pro}"
WEIGHTS_DEFAULT="/tts/models/Fish-Audio/S2-Pro-Safetensors"

PORT="${PORT:-8882}"
HOST="${HOST:-0.0.0.0}"
MODEL_PATH="${MODEL_PATH:-$WEIGHTS_DEFAULT}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)        PORT="$2"; shift 2;;
        --host)        HOST="$2"; shift 2;;
        --model-path)  MODEL_PATH="$2"; shift 2;;
        *) echo "Unknown arg: $1"; exit 1;;
    esac
done

# Resolve config — sglang-omni ships an example yaml that wires the
# S2-Pro architecture to its TTS pipeline. Pin to the file in the
# clone we built against.
CONFIG="$INSTALL_DIR/source/examples/configs/s2pro_tts.yaml"
if [ ! -f "$CONFIG" ]; then
    echo "ERROR: config not found at $CONFIG"
    echo "  Re-run the install to refresh the sglang-omni clone"
    exit 1
fi

if [ ! -d "$MODEL_PATH" ]; then
    echo "WARN: $MODEL_PATH not found locally — sglang-omni will try to fetch from HuggingFace"
fi

# Put the conda env's bin on PATH so flashinfer's JIT compiler can
# find `ninja` (and other build tools) when it compiles attention
# kernels at first launch. Without this, sgl-omni crashes during
# CUDA graph capture with FileNotFoundError: 'ninja'.
export PATH="/opt/conda/envs/s2-pro/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

# Point flashinfer's JIT compiler at the conda-installed CUDA
# toolchain. flashinfer hard-codes /usr/local/cuda/bin/nvcc as the
# fallback path; setting CUDA_HOME makes it use the env-local nvcc
# installed via conda-forge cuda-nvcc=12.8. Without this, JIT bombs
# with "/usr/local/cuda/bin/nvcc: not found" during CUDA graph capture.
export CUDA_HOME="/opt/conda/envs/s2-pro"

# Tell nvcc to use the conda-installed gcc-12 as the host compiler
# instead of the system gcc. Debian 13 / Ubuntu 24.04 ship gcc that
# pull in glibc ≥2.36 headers — those add `noexcept` to sinpi/cospi
# in <math.h>, which conflicts with CUDA 12.8's math_functions.h
# and crashes JIT compile with "exception specification is
# incompatible with that of previous function". The conda gcc-12
# bundle ships sysroot_linux-64=2.17 with compatible math headers.
# CUDAHOSTCXX is what torch.utils.cpp_extension reads.
# NVCC_PREPEND_FLAGS feeds the same -ccbin to flashinfer's JIT.
export CUDAHOSTCXX="/opt/conda/envs/s2-pro/bin/x86_64-conda-linux-gnu-g++"
export NVCC_PREPEND_FLAGS="-ccbin /opt/conda/envs/s2-pro/bin/x86_64-conda-linux-gnu-g++"

# Detect visible GPU's compute capability (honors CUDA_VISIBLE_DEVICES;
# uses the first visible device, which is gpu_id=0 from sglang's view).
# Used for both attention-backend selection and arch-scoped JIT caches.
DETECTED_CAP=$(/opt/conda/envs/s2-pro/bin/python3 -c "
import torch
if torch.cuda.is_available():
    maj, minr = torch.cuda.get_device_capability(0)
    print(f'sm_{maj}{minr}')
else:
    print('none')
" 2>/dev/null || echo "unknown")

# Arch-scope the JIT caches so swapping GPUs doesn't reuse a cubin
# compiled for the wrong arch. sglang's tvm-ffi cache and flashinfer's
# JIT cache both key by kernel signature, NOT by arch — so a kernel
# JIT-built on sm_120 hardware will be served back when you next
# launch on sm_89, fail with "no kernel image is available", and the
# first-failure mode of the entire server. Per-arch dirs sidestep that.
export TVM_FFI_CACHE_DIR="/root/.cache/tvm-ffi-${DETECTED_CAP}"
export FLASHINFER_WORKSPACE_BASE="/root/.cache/flashinfer-${DETECTED_CAP}"
mkdir -p "$TVM_FFI_CACHE_DIR" "$FLASHINFER_WORKSPACE_BASE"

# Attention backend selector — auto-pick based on the visible GPU's
# compute capability if not explicitly set. fa2 (the prebuilt
# flash-attn 2.8.3 wheel) ships sm_80/sm_90/sm_100/sm_120 cubins; any
# other arch (notably sm_89 = RTX 4090, sm_86 = RTX 30xx in some cases,
# sm_75 = Turing) falls back to triton, which JIT-compiles per-arch
# and works everywhere. Read by the install-script-patched factory.py.
if [ -z "${S2PRO_ATTENTION_BACKEND:-}" ]; then
    case "$DETECTED_CAP" in
        sm_80|sm_90|sm_90a|sm_100|sm_100a|sm_120|sm_120a)
            S2PRO_ATTENTION_BACKEND="fa2"
            ;;
        *)
            # sm_89 (4090), sm_86 (30xx), sm_75 (Turing), or anything
            # else fa2 doesn't cover.
            S2PRO_ATTENTION_BACKEND="triton"
            ;;
    esac
    echo "[s2-pro] Detected GPU cap: $DETECTED_CAP -> attention_backend=$S2PRO_ATTENTION_BACKEND"
else
    echo "[s2-pro] Using S2PRO_ATTENTION_BACKEND=$S2PRO_ATTENTION_BACKEND (env override) on $DETECTED_CAP"
fi
export S2PRO_ATTENTION_BACKEND

exec /opt/conda/envs/s2-pro/bin/sgl-omni serve \
    --model-path "$MODEL_PATH" \
    --config "$CONFIG" \
    --host "$HOST" \
    --port "$PORT"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    # Record version (commit sha — sglang-omni is young, no semver tags).
    VER=$(git -C "$INSTALL_DIR/source" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    echo "Fish-Audio S2-Pro installed: $VER"
    echo "Launch:  $INSTALL_DIR/serve.sh --port 8882"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    echo "Removing Fish-Audio S2-Pro..."
    rm -rf "$INSTALL_DIR"
    if conda env list | awk '{print $1}' | grep -qx "$CONDA_ENV"; then
        conda env remove -n "$CONDA_ENV" -y 2>&1
    fi
    echo "PROXLAB_STATUS=uninstalled"
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/serve.sh" ]; then
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
