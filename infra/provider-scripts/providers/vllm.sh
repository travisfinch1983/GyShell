#!/bin/bash
# ProxLab Provider Installer: vLLM
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./vllm.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/vllm)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/vllm}"
ARCHS="${PROXLAB_GPU_ARCHS:-}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-vllm}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        # Verify the actual install is intact
        if conda run -n "$CONDA_ENV" python3 -c "import vllm; print(vllm.__version__)" &>/dev/null; then
            echo "vLLM already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "vLLM version file exists but import failed — reinstalling"
    fi

    # Verify prereqs
    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Check PyTorch + CUDA
    CUDA_AVAIL=$(conda run -n "$CONDA_ENV" python3 -c "import torch; print(torch.cuda.is_available())" 2>/dev/null || echo "False")
    if [ "$CUDA_AVAIL" != "True" ]; then
        echo "WARNING: PyTorch CUDA not available — vLLM may not work with GPU"
    fi

    mkdir -p "$INSTALL_DIR"

    echo "Installing vLLM..."

    # Volta (V100) needs specific handling — same pip package, different runtime flags
    if echo "$ARCHS" | grep -qiE "volta"; then
        echo "Volta architecture detected — vLLM will use Triton attention (no FlashAttention 2)"
    fi

    conda run -n "$CONDA_ENV" pip install vllm 2>&1

    # flashinfer-cubin and flashinfer can have version mismatches (e.g. 0.6.1 vs 0.5.1).
    # Pin flashinfer-cubin to match flashinfer if both are installed.
    echo "Checking flashinfer version compatibility..."
    FLASHINFER_VER=$(conda run -n "$CONDA_ENV" pip show flashinfer 2>/dev/null | grep -oP '^Version: \K.*' || echo "")
    FLASHINFER_CUBIN_VER=$(conda run -n "$CONDA_ENV" pip show flashinfer-cubin 2>/dev/null | grep -oP '^Version: \K.*' || echo "")
    if [ -n "$FLASHINFER_VER" ] && [ -n "$FLASHINFER_CUBIN_VER" ] && [ "$FLASHINFER_VER" != "$FLASHINFER_CUBIN_VER" ]; then
        echo "flashinfer=${FLASHINFER_VER} vs flashinfer-cubin=${FLASHINFER_CUBIN_VER} — pinning cubin to match"
        conda run -n "$CONDA_ENV" pip install "flashinfer-cubin==${FLASHINFER_VER}" 2>&1 || {
            echo "WARNING: Could not pin flashinfer-cubin — FLASHINFER_DISABLE_VERSION_CHECK=1 will be set at runtime"
        }
    fi

    # Get installed version
    VER=$(conda run -n "$CONDA_ENV" python3 -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "unknown")

    if [ "$VER" = "unknown" ]; then
        echo "ERROR: vLLM installation failed — import not working"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Save version
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher script
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# vLLM serve wrapper — usage: ./serve.sh <model_path> [args...]
export PATH="/opt/conda/bin:$PATH"
# flashinfer-cubin and flashinfer versions may mismatch — disable the check
export FLASHINFER_DISABLE_VERSION_CHECK=1
MODEL="${1:?Usage: serve.sh <model_path> [extra vllm args...]}"
shift
exec conda run -n "${PROXLAB_CONDA_ENV:-vllm}" \
    vllm serve "$MODEL" "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "vLLM ${VER} installed to $INSTALL_DIR"

    # ─── Shared Folder Symlinks ──────────────────────────────────────────
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "llm-models" "$INSTALL_DIR/models"
    fi

    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    # Remove the conda environment (if not base)
    if command -v conda &>/dev/null && [ "$CONDA_ENV" != "base" ]; then
        echo "Removing conda environment: $CONDA_ENV"
        conda env remove -n "$CONDA_ENV" -y 2>/dev/null || true
    elif command -v conda &>/dev/null; then
        conda run -n "$CONDA_ENV" pip uninstall -y vllm 2>/dev/null || true
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
    echo "Current version: $OLD_VER"
    echo "Upgrading vLLM..."

    conda run -n "$CONDA_ENV" pip install --upgrade vllm 2>&1

    # Fix flashinfer version mismatches after upgrade
    echo "Checking flashinfer version compatibility..."
    FLASHINFER_VER=$(conda run -n "$CONDA_ENV" pip show flashinfer 2>/dev/null | grep -oP '^Version: \K.*' || echo "")
    FLASHINFER_CUBIN_VER=$(conda run -n "$CONDA_ENV" pip show flashinfer-cubin 2>/dev/null | grep -oP '^Version: \K.*' || echo "")
    if [ -n "$FLASHINFER_VER" ] && [ -n "$FLASHINFER_CUBIN_VER" ] && [ "$FLASHINFER_VER" != "$FLASHINFER_CUBIN_VER" ]; then
        echo "flashinfer=${FLASHINFER_VER} vs flashinfer-cubin=${FLASHINFER_CUBIN_VER} — pinning cubin to match"
        conda run -n "$CONDA_ENV" pip install "flashinfer-cubin==${FLASHINFER_VER}" 2>&1 || true
    fi

    NEW_VER=$(conda run -n "$CONDA_ENV" python3 -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "unknown")
    echo "$NEW_VER" > "$INSTALL_DIR/.version"

    if [ "$OLD_VER" = "$NEW_VER" ]; then
        echo "Already at latest version: $NEW_VER"
    else
        echo "Updated: $OLD_VER → $NEW_VER"
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
    # Fast check: query PyPI JSON API directly (no conda overhead)
    LATEST=$(python3 -c "
import urllib.request, json, sys
try:
    r = urllib.request.urlopen('https://pypi.org/pypi/vllm/json', timeout=10)
    print(json.loads(r.read())['info']['version'])
except:
    pass
" 2>/dev/null)

    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$CURRENT"
    if [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ]; then
        echo "PROXLAB_UPDATE_AVAILABLE=$LATEST"
    fi
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        # Verify import works
        if command -v conda &>/dev/null; then
            ACTUAL=$(conda run -n "$CONDA_ENV" python3 -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "")
            if [ -n "$ACTUAL" ]; then
                echo "PROXLAB_STATUS=installed"
                echo "PROXLAB_VERSION=$ACTUAL"
                return
            fi
        fi
        # Version file exists but can't verify
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$VER"
    else
        echo "PROXLAB_STATUS=not_installed"
    fi
}

# ─── Dispatch ────────────────────────────────────────────────────────────

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
