#!/bin/bash
# ProxLab Provider Installer: OpenedAI Speech
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./openedai-speech.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
# OpenedAI Speech is an OpenAI-compatible TTS API that wraps XTTS, Piper,
# and other backends. Git-clone based install.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/openedai-speech)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/openedai-speech}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-openedai-speech}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if [ -f "$INSTALL_DIR/speech.py" ]; then
            echo "OpenedAI Speech already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "OpenedAI Speech version file exists but speech.py missing — reinstalling"
    fi

    # Verify prereqs
    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing OpenedAI Speech..."

    # Clone or update the repo
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo "Updating existing OpenedAI Speech repo..."
        git -C "$INSTALL_DIR" pull --ff-only 2>&1 || {
            echo "WARNING: git pull failed, continuing with existing version"
        }
    else
        rm -rf "$INSTALL_DIR"
        echo "Cloning OpenedAI Speech..."
        git clone https://github.com/matatonic/openedai-speech.git "$INSTALL_DIR" 2>&1
    fi

    # Install dependencies
    echo "Installing OpenedAI Speech dependencies..."
    if [ -f "$INSTALL_DIR/requirements.txt" ]; then
        conda run -n "$CONDA_ENV" pip install -r "$INSTALL_DIR/requirements.txt" 2>&1
    else
        echo "WARNING: No requirements.txt found — attempting pyproject.toml install"
        conda run -n "$CONDA_ENV" pip install -e "$INSTALL_DIR" 2>&1 || true
    fi

    # Get version from git tag or commit
    VER=$(git -C "$INSTALL_DIR" describe --tags --always 2>/dev/null || echo "unknown")
    if [ "$VER" = "unknown" ]; then
        VER=$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo "git-unknown")
    fi

    # Save version
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher script
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# OpenedAI Speech serve wrapper — usage: ./serve.sh [args...]
export PATH="/opt/conda/bin:$PATH"
cd "$(dirname "$0")"
exec conda run -n "${PROXLAB_CONDA_ENV:-openedai-speech}" \
    python3 speech.py --host 0.0.0.0 --port 8000 "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "OpenedAI Speech ${VER} installed to $INSTALL_DIR"
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
        if [ -f "$INSTALL_DIR/speech.py" ]; then
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$VER"
        else
            echo "PROXLAB_STATUS=not_installed"
        fi
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
