#!/bin/bash
# ProxLab Provider Installer: LMDeploy
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./lmdeploy.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/lmdeploy)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/lmdeploy}"
ARCHS="${PROXLAB_GPU_ARCHS:-}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-lmdeploy}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import lmdeploy; print(lmdeploy.__version__)" &>/dev/null; then
            echo "LMDeploy already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "LMDeploy version file exists but import failed — reinstalling"
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
        echo "WARNING: PyTorch CUDA not available — LMDeploy may not work with GPU"
    fi

    mkdir -p "$INSTALL_DIR"

    echo "Installing LMDeploy..."
    conda run -n "$CONDA_ENV" pip install lmdeploy 2>&1

    # Get installed version
    VER=$(conda run -n "$CONDA_ENV" python3 -c "import lmdeploy; print(lmdeploy.__version__)" 2>/dev/null || echo "unknown")

    if [ "$VER" = "unknown" ]; then
        echo "ERROR: LMDeploy installation failed — import not working"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Save version
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# LMDeploy serve wrapper — usage: ./serve.sh <model_path> [args...]
export PATH="/opt/conda/bin:$PATH"
MODEL="${1:?Usage: serve.sh <model_path> [extra lmdeploy args...]}"
shift
exec conda run -n "${PROXLAB_CONDA_ENV:-lmdeploy}" \
    lmdeploy serve api_server "$MODEL" "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "LMDeploy ${VER} installed to $INSTALL_DIR"

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
        conda run -n "$CONDA_ENV" pip uninstall -y lmdeploy 2>/dev/null || true
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
            ACTUAL=$(conda run -n "$CONDA_ENV" python3 -c "import lmdeploy; print(lmdeploy.__version__)" 2>/dev/null || echo "")
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
