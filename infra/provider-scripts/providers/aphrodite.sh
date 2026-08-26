#!/bin/bash
# ProxLab Provider Installer: Aphrodite Engine
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./aphrodite.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
# Aphrodite is a vLLM fork with EXL2 + GGUF support and advanced samplers
# (DRY, XTC, Mirostat). Good for creative/RP workloads.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/aphrodite)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/aphrodite}"
ARCHS="${PROXLAB_GPU_ARCHS:-}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-aphrodite}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import aphrodite; print(aphrodite.__version__)" &>/dev/null; then
            echo "Aphrodite already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "Aphrodite version file exists but import failed — reinstalling"
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
        echo "WARNING: PyTorch CUDA not available — Aphrodite may not work with GPU"
    fi

    mkdir -p "$INSTALL_DIR"

    echo "Installing Aphrodite Engine..."
    conda run -n "$CONDA_ENV" pip install aphrodite-engine 2>&1

    # aphrodite-kernels is a separate 1.3GB package hosted on Pygmalion's wheel index.
    # Required for Aphrodite to start — import fails without it.
    echo "Installing aphrodite-kernels..."
    conda run -n "$CONDA_ENV" pip install \
        --extra-index-url https://downloads.pygmalion.chat/whl \
        aphrodite-kernels 2>&1 || {
        echo "WARNING: aphrodite-kernels install failed — Aphrodite may not start"
    }

    # Get installed version
    VER=$(conda run -n "$CONDA_ENV" python3 -c "import aphrodite; print(aphrodite.__version__)" 2>/dev/null || echo "unknown")

    if [ "$VER" = "unknown" ]; then
        # Try alternative version detection
        VER=$(conda run -n "$CONDA_ENV" pip show aphrodite-engine 2>/dev/null | grep -oP '^Version: \K.*' || echo "unknown")
    fi

    if [ "$VER" = "unknown" ]; then
        echo "ERROR: Aphrodite installation failed — import not working"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Save version
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher script
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# Aphrodite serve wrapper — usage: ./serve.sh <model_path> [args...]
export PATH="/opt/conda/bin:$PATH"
# Bypass flashinfer version check (SGLang installs a different version)
export FLASHINFER_DISABLE_VERSION_CHECK=1
# V100 (Volta, SM70) doesn't support Flash Attention 2 (requires SM80+).
# Detect compute capability and force TORCH_SDPA if needed.
if command -v nvidia-smi &>/dev/null; then
    CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '.')
    if [ -n "$CC" ] && [ "$CC" -lt 80 ] 2>/dev/null; then
        export APHRODITE_ATTENTION_BACKEND=TORCH_SDPA
    fi
fi
MODEL="${1:?Usage: serve.sh <model_path> [extra aphrodite args...]}"
shift
exec conda run -n "${PROXLAB_CONDA_ENV:-aphrodite}" \
    aphrodite run "$MODEL" "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "Aphrodite ${VER} installed to $INSTALL_DIR"

    # ─── Shared Folder Symlinks ──────────────────────────────────────────
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "llm-models" "$INSTALL_DIR/models"
    fi

    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    if command -v conda &>/dev/null && [ "$CONDA_ENV" != "base" ]; then
        echo "Removing conda environment: $CONDA_ENV"
        conda env remove -n "$CONDA_ENV" -y 2>/dev/null || true
    elif command -v conda &>/dev/null; then
        conda run -n "$CONDA_ENV" pip uninstall -y aphrodite-engine 2>/dev/null || true
    fi

    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed $INSTALL_DIR"
    fi
    echo "PROXLAB_STATUS=not_installed"
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        if command -v conda &>/dev/null; then
            ACTUAL=$(conda run -n "$CONDA_ENV" python3 -c "import aphrodite; print(aphrodite.__version__)" 2>/dev/null || echo "")
            if [ -n "$ACTUAL" ]; then
                echo "PROXLAB_STATUS=installed"
                echo "PROXLAB_VERSION=$ACTUAL"
                return
            fi
            # Fallback to pip show
            ACTUAL=$(conda run -n "$CONDA_ENV" pip show aphrodite-engine 2>/dev/null | grep -oP '^Version: \K.*' || echo "")
            if [ -n "$ACTUAL" ]; then
                echo "PROXLAB_STATUS=installed"
                echo "PROXLAB_VERSION=$ACTUAL"
                return
            fi
        fi
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$VER"
    else
        echo "PROXLAB_STATUS=not_installed"
    fi
}

# ─── Dispatch ────────────────────────────────────────────────────────────

case "$ACTION" in
    install)   do_install   ;;
    uninstall) do_uninstall ;;
    status)    do_status    ;;
    *)
        echo "Usage: $0 {install|uninstall|status}"
        exit 1
        ;;
esac
