#!/bin/bash
# ProxLab Provider Installer: Kokoro TTS (Kokoro-FastAPI)
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./kokoro.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
# Kokoro TTS is a lightweight 82M parameter model with an OpenAI-compatible API.
# Git-clone based install.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/kokoro)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/kokoro}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-kokoro}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if [ -d "$INSTALL_DIR/api" ]; then
            echo "Kokoro TTS already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "Kokoro version file exists but api/ missing — reinstalling"
    fi

    # Verify prereqs
    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing Kokoro TTS (Kokoro-FastAPI)..."

    # Clone or update the repo
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo "Updating existing Kokoro repo..."
        git -C "$INSTALL_DIR" pull --ff-only 2>&1 || {
            echo "WARNING: git pull failed, continuing with existing version"
        }
    else
        rm -rf "$INSTALL_DIR"
        echo "Cloning Kokoro-FastAPI..."
        git clone https://github.com/remsky/Kokoro-FastAPI.git "$INSTALL_DIR" 2>&1
    fi

    # Install dependencies
    echo "Installing Kokoro dependencies..."
    if [ -f "$INSTALL_DIR/requirements.txt" ]; then
        conda run -n "$CONDA_ENV" pip install -r "$INSTALL_DIR/requirements.txt" 2>&1
    elif [ -f "$INSTALL_DIR/api/requirements.txt" ]; then
        conda run -n "$CONDA_ENV" pip install -r "$INSTALL_DIR/api/requirements.txt" 2>&1
    else
        echo "WARNING: No requirements file found — attempting pyproject.toml install"
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
# Kokoro TTS serve wrapper — usage: ./serve.sh [args...]
export PATH="/opt/conda/bin:$PATH"
cd "$(dirname "$0")"
exec conda run -n "${PROXLAB_CONDA_ENV:-kokoro}" \
    python3 -m uvicorn api.src.main:app --host 0.0.0.0 --port 8880 "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "Kokoro TTS ${VER} installed to $INSTALL_DIR"
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
        if [ -d "$INSTALL_DIR/api" ]; then
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
