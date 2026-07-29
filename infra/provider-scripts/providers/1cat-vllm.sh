#!/bin/bash
# ProxLab Provider Installer: 1Cat-vLLM
# Usage: PROXLAB_GPU_ARCHS="Volta" ./1cat-vllm.sh [install|uninstall|status|update|check-update]
#
# 1Cat-vLLM is a Tesla V100 / SM70 focused vLLM fork:
#   https://github.com/1CatAI/1Cat-vLLM
# Adds FLASH_ATTN_V100 attention backend, AWQ kernels backported to SM70 from
# TurboMind/LMDeploy, native MTP speculative decoding, and 256K context defaults.
#
# Installation uses the project's prebuilt wheels (Python 3.12 / CUDA 12.8 / cu128 torch).
# A dedicated conda env (1cat-vllm-sm70) keeps it isolated from any other vLLM install,
# since both packages ship as "vllm" and would clash in a shared environment.

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/1cat-vllm}"
ARCHS="${PROXLAB_GPU_ARCHS:-}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-1cat-vllm-sm70}"
GH_REPO="1CatAI/1Cat-vLLM"
PYTHON_VER="3.12"
TORCH_INDEX="https://download.pytorch.org/whl/cu128"

export PATH="/opt/conda/bin:$PATH"

# ─── Helpers ─────────────────────────────────────────────────────────────

# Fetch the two release asset download URLs (flash_attn_v100 wheel + vllm wheel)
# from the latest release of the GitHub repo. Stdout: URL per line.
fetch_release_wheel_urls() {
    # Use the unauthenticated GitHub REST endpoint; 60 req/hr per IP is fine
    # for a single install. If rate-limited the user can pass a token via
    # PROXLAB_GH_TOKEN.
    local auth=""
    if [ -n "${PROXLAB_GH_TOKEN:-}" ]; then
        auth="-H \"Authorization: token ${PROXLAB_GH_TOKEN}\""
    fi
    python3 - "$GH_REPO" <<'PYEOF'
import json, os, sys, urllib.request
repo = sys.argv[1]
req = urllib.request.Request(f"https://api.github.com/repos/{repo}/releases/latest")
tok = os.environ.get("PROXLAB_GH_TOKEN", "").strip()
if tok:
    req.add_header("Authorization", f"token {tok}")
try:
    data = json.loads(urllib.request.urlopen(req, timeout=15).read())
except Exception as e:
    print(f"ERROR_FETCHING_RELEASE: {e}", file=sys.stderr)
    sys.exit(1)
flash_url = None
vllm_url = None
for a in data.get("assets", []):
    name = a["name"]
    if name.startswith("flash_attn_v100-") and name.endswith(".whl"):
        flash_url = a["browser_download_url"]
    elif name.startswith("vllm-") and name.endswith(".whl"):
        vllm_url = a["browser_download_url"]
if not flash_url or not vllm_url:
    print("ERROR: expected wheels not found in latest release", file=sys.stderr)
    sys.exit(1)
print(data.get("tag_name", "unknown"))
print(flash_url)
print(vllm_url)
PYEOF
}

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Volta gate — this fork is SM70-only by design
    if [ -n "$ARCHS" ] && ! echo "$ARCHS" | grep -qiE "volta"; then
        echo "ERROR: 1Cat-vLLM is V100/SM70-only. Detected archs: $ARCHS"
        echo "Use the standard 'vllm' provider for other GPUs."
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import vllm; print(vllm.__version__)" &>/dev/null; then
            echo "1Cat-vLLM already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "Version file exists but import failed — reinstalling"
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    mkdir -p "$INSTALL_DIR"

    # ─── 1. Create dedicated conda env with Python 3.12 ──────────────────
    if ! conda env list | awk '{print $1}' | grep -qx "$CONDA_ENV"; then
        echo "Creating conda env $CONDA_ENV (Python $PYTHON_VER)..."
        conda create -y -n "$CONDA_ENV" "python=$PYTHON_VER"
    else
        echo "conda env $CONDA_ENV already exists — reusing"
    fi

    # ─── 2. Upgrade pip toolchain + install cu128 PyTorch ────────────────
    echo "Installing PyTorch (cu128) into $CONDA_ENV ..."
    conda run -n "$CONDA_ENV" python -m pip install --upgrade pip setuptools wheel
    conda run -n "$CONDA_ENV" python -m pip install --index-url "$TORCH_INDEX" torch torchvision

    # ─── 3. Download the two release wheels ──────────────────────────────
    echo "Fetching latest 1Cat-vLLM release wheel URLs from GitHub ..."
    mapfile -t REL < <(fetch_release_wheel_urls)
    if [ "${#REL[@]}" -lt 3 ]; then
        echo "ERROR: could not parse latest release wheels"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi
    REL_TAG="${REL[0]}"
    FLASH_URL="${REL[1]}"
    VLLM_URL="${REL[2]}"
    echo "Latest release: $REL_TAG"
    echo "  flash_attn_v100: ${FLASH_URL##*/}"
    echo "  vllm:            ${VLLM_URL##*/}"

    WHEEL_DIR="$INSTALL_DIR/wheels"
    mkdir -p "$WHEEL_DIR"
    echo "Downloading wheels into $WHEEL_DIR ..."
    (cd "$WHEEL_DIR" && curl -L -fSs -O "$FLASH_URL" && curl -L -fSs -O "$VLLM_URL")

    # ─── 4. Install wheels into the env ──────────────────────────────────
    # Use --prefer-binary --no-cache-dir per project's installation guidance.
    # --extra-index-url ensures dependency resolution can still pull cu128 packages.
    echo "Installing wheels into $CONDA_ENV ..."
    conda run -n "$CONDA_ENV" python -m pip install --prefer-binary --no-cache-dir \
        --extra-index-url "$TORCH_INDEX" \
        "$WHEEL_DIR"/flash_attn_v100-*.whl \
        "$WHEEL_DIR"/vllm-*.whl

    # ─── 5. Verify the install ───────────────────────────────────────────
    # Run from /tmp so Python doesn't pick up a stray source tree.
    echo "Verifying install ..."
    VERIFY_OUT=$(cd /tmp && conda run -n "$CONDA_ENV" python - <<'PY' 2>&1
import sys
import torch
import vllm
try:
    import flash_attn_v100_cuda  # noqa: F401
    fa_ok = "ok"
except Exception as e:
    fa_ok = f"FAIL: {e}"
print(f"python={sys.version.split()[0]}")
print(f"torch={torch.__version__}")
print(f"torch_cuda={torch.version.cuda}")
print(f"vllm={vllm.__version__}")
print(f"flash_attn_v100={fa_ok}")
PY
    )
    echo "$VERIFY_OUT"
    if ! echo "$VERIFY_OUT" | grep -q "flash_attn_v100=ok"; then
        echo "ERROR: verification failed — flash_attn_v100 import did not load"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi
    VLLM_VER=$(echo "$VERIFY_OUT" | sed -n 's/^vllm=//p')

    # ─── 6. Write version marker + convenience serve wrapper ─────────────
    echo "${REL_TAG} (vllm=${VLLM_VER})" > "$INSTALL_DIR/.version"

    cat > "$INSTALL_DIR/serve.sh" <<'SERVE_EOF'
#!/bin/bash
# 1Cat-vLLM serve wrapper.
#
# Usage: serve.sh <model_path> [extra args ...]
#
# Defaults:
#   - FLASH_ATTN_V100 attention backend (the fork's V100-tuned path)
#   - bfloat16 dtype (works for both BF16 and FP16 safetensor models)
#   - port 8000
#   - 256K context, gpu-memory-utilization=0.88
#   - tensor-parallel size derived from CUDA_VISIBLE_DEVICES if set, else 1
# Override any of these by passing flags after the model path.
export PATH="/opt/conda/bin:$PATH"
CONDA_ENV="${PROXLAB_CONDA_ENV:-1cat-vllm-sm70}"
MODEL="${1:?Usage: serve.sh <model_path> [extra vllm args...]}"
shift

# Derive TP from CUDA_VISIBLE_DEVICES if user didn't override
TP_DEFAULT=1
if [ -n "${CUDA_VISIBLE_DEVICES:-}" ]; then
    TP_DEFAULT=$(echo "$CUDA_VISIBLE_DEVICES" | tr ',' '\n' | wc -l)
fi
TP="${VLLM_TP:-$TP_DEFAULT}"

exec conda run -n "$CONDA_ENV" python -m vllm.entrypoints.openai.api_server \
    --model "$MODEL" \
    --attention-backend FLASH_ATTN_V100 \
    --tensor-parallel-size "$TP" \
    --gpu-memory-utilization 0.88 \
    --max-model-len "${VLLM_MAX_MODEL_LEN:-262144}" \
    --max-num-seqs "${VLLM_MAX_NUM_SEQS:-1}" \
    --max-num-batched-tokens "${VLLM_MAX_NUM_BATCHED_TOKENS:-8192}" \
    --dtype "${VLLM_DTYPE:-bfloat16}" \
    --host 0.0.0.0 \
    --port "${VLLM_PORT:-8000}" \
    "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    # ─── 7. Shared folder symlinks (so /opt/1cat-vllm/models -> /llm) ────
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "llm-models" "$INSTALL_DIR/models"
    fi

    echo "1Cat-vLLM ${REL_TAG} installed to $INSTALL_DIR"
    echo "Conda env: $CONDA_ENV"
    echo "Wrapper:   $INSTALL_DIR/serve.sh"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=${REL_TAG}"
}

do_uninstall() {
    if command -v conda &>/dev/null && [ "$CONDA_ENV" != "base" ]; then
        echo "Removing conda environment: $CONDA_ENV"
        conda env remove -n "$CONDA_ENV" -y 2>/dev/null || true
    fi
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed $INSTALL_DIR"
    fi
    echo "PROXLAB_STATUS=not_installed"
}

do_update() {
    if [ ! -f "$INSTALL_DIR/.version" ]; then
        echo "Not installed — run install first"
        echo "PROXLAB_STATUS=not_installed"
        return 1
    fi
    OLD_VER=$(cat "$INSTALL_DIR/.version")
    echo "Current: $OLD_VER"

    # Re-download latest wheels and pip-install them in place
    mapfile -t REL < <(fetch_release_wheel_urls)
    if [ "${#REL[@]}" -lt 3 ]; then
        echo "ERROR: could not fetch release info"
        echo "PROXLAB_STATUS=error"
        return 1
    fi
    REL_TAG="${REL[0]}"
    FLASH_URL="${REL[1]}"
    VLLM_URL="${REL[2]}"

    WHEEL_DIR="$INSTALL_DIR/wheels"
    rm -rf "$WHEEL_DIR" && mkdir -p "$WHEEL_DIR"
    (cd "$WHEEL_DIR" && curl -L -fSs -O "$FLASH_URL" && curl -L -fSs -O "$VLLM_URL")

    conda run -n "$CONDA_ENV" python -m pip install --upgrade --prefer-binary --no-cache-dir \
        --extra-index-url "$TORCH_INDEX" \
        "$WHEEL_DIR"/flash_attn_v100-*.whl \
        "$WHEEL_DIR"/vllm-*.whl

    NEW_VLLM=$(conda run -n "$CONDA_ENV" python3 -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "unknown")
    NEW_VER="${REL_TAG} (vllm=${NEW_VLLM})"
    echo "$NEW_VER" > "$INSTALL_DIR/.version"
    if [ "$OLD_VER" = "$NEW_VER" ]; then
        echo "Already at latest: $NEW_VER"
    else
        echo "Updated: $OLD_VER -> $NEW_VER"
    fi
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$NEW_VER"
}

do_check_update() {
    if [ ! -f "$INSTALL_DIR/.version" ]; then
        echo "PROXLAB_STATUS=not_installed"
        return
    fi
    CURRENT=$(cat "$INSTALL_DIR/.version")
    LATEST=$(python3 -c "
import json, urllib.request
try:
    r = urllib.request.urlopen('https://api.github.com/repos/${GH_REPO}/releases/latest', timeout=10)
    print(json.loads(r.read())['tag_name'])
except Exception:
    pass
" 2>/dev/null)
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$CURRENT"
    if [ -n "$LATEST" ] && ! echo "$CURRENT" | grep -qF "$LATEST"; then
        echo "PROXLAB_UPDATE_AVAILABLE=$LATEST"
    fi
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        if command -v conda &>/dev/null; then
            ACTUAL=$(conda run -n "$CONDA_ENV" python3 -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "")
            if [ -n "$ACTUAL" ]; then
                echo "PROXLAB_STATUS=installed"
                echo "PROXLAB_VERSION=$VER"
                return
            fi
        fi
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$VER"
    else
        echo "PROXLAB_STATUS=not_installed"
    fi
}

case "$ACTION" in
    install)      do_install      ;;
    uninstall)    do_uninstall    ;;
    status)       do_status       ;;
    update)       do_update       ;;
    check-update) do_check_update ;;
    *)
        echo "Usage: $0 {install|uninstall|status|update|check-update}"
        exit 1
        ;;
esac
