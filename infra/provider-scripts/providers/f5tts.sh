#!/bin/bash
# ProxLab Provider Installer: F5-TTS
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./f5tts.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
# F5-TTS is a zero-shot voice cloning system using flow matching for fast inference.
# Installed via pip (f5-tts package).
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/f5tts)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/f5tts}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-f5tts}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        echo "F5-TTS already installed: $EXISTING_VER"
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$EXISTING_VER"
        return 0
    fi

    # Verify prereqs
    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing F5-TTS..."

    # Install via pip
    conda run -n "$CONDA_ENV" pip install f5-tts 2>&1

    # Get version
    VER=$(conda run -n "$CONDA_ENV" pip show f5-tts 2>/dev/null | grep "^Version:" | awk '{print $2}' || echo "unknown")

    # Create install dir for version tracking and launcher
    mkdir -p "$INSTALL_DIR"
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher script
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# F5-TTS serve wrapper — usage: ./serve.sh [args...]
export PATH="/opt/conda/bin:$PATH"
exec conda run -n "${PROXLAB_CONDA_ENV:-f5tts}" \
    f5-tts_infer-gradio --host 0.0.0.0 --port 7860 "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "F5-TTS ${VER} installed"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
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

do_status() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
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
