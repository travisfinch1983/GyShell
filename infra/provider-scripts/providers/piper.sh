#!/bin/bash
# ProxLab Provider Installer: Piper TTS
# Usage: ./piper.sh [install|uninstall|status]
#
# Piper is a lightweight VITS-based TTS engine optimized for CPU inference.
# Generates speech in ~20-30ms per sentence. Includes HTTP server and
# Wyoming protocol support for Home Assistant integration.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/piper)
#   PROXLAB_CONDA_ENV   - Conda env name (default: piper)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/piper}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-piper}"
VOICES_DIR="$INSTALL_DIR/voices"
WHISPER_SERVER="$INSTALL_DIR/whisper_server.py"

# Default voices to download (name quality size)
DEFAULT_VOICES=(
    "en_US-lessac-medium"
    "en_US-lessac-high"
    "en_US-ryan-high"
    "en_GB-jenny_dioco-medium"
)

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import piper" 2>/dev/null; then
            echo "Piper TTS already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "Piper version file exists but module missing — reinstalling"
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Create conda env if it doesn't exist (lightweight providers skip pytorch prereq)
    PYTHON_VER="${PROXLAB_PYTHON_VERSION:-3.12}"
    if [ "$CONDA_ENV" != "base" ]; then
        if ! conda env list 2>/dev/null | grep -qw "^${CONDA_ENV} "; then
            echo "Creating conda environment: $CONDA_ENV (Python ${PYTHON_VER})..."
            conda create -n "$CONDA_ENV" python="$PYTHON_VER" -y 2>&1
        else
            echo "Conda environment '$CONDA_ENV' already exists"
        fi
    fi

    echo "Installing Piper TTS..."

    # Install piper-tts with HTTP server support
    conda run -n "$CONDA_ENV" pip install "piper-tts[http]" 2>&1

    # Create install dir and voices dir
    mkdir -p "$VOICES_DIR"

    # Download default voices
    echo "Downloading default voices..."
    for voice in "${DEFAULT_VOICES[@]}"; do
        echo "  Downloading voice: $voice"
        conda run -n "$CONDA_ENV" python3 -c "
from piper.download import get_voices, ensure_voice_exists
import json, urllib.request

voices_info = get_voices(download_dir='$VOICES_DIR', update_voices=True)
ensure_voice_exists('$voice', data_dirs=['$VOICES_DIR'], download_dir='$VOICES_DIR', voices_info=voices_info)
print('  OK: $voice')
" 2>&1 || echo "  WARNING: Failed to download $voice (non-fatal)"
    done

    # Get version
    VER=$(conda run -n "$CONDA_ENV" python3 -c "import piper; print(piper.__version__)" 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher scripts
    cat > "$INSTALL_DIR/serve.sh" << SERVE_EOF
#!/bin/bash
# Piper TTS HTTP server — usage: ./serve.sh [--port 5000]
exec /opt/conda/envs/$CONDA_ENV/bin/python3 -m piper.http_server \\
    --data-dir "$VOICES_DIR" \\
    -m en_US-lessac-medium \\
    --host 0.0.0.0 --port \${1:-5000}
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    # ─── Shared Folder Symlinks ──────────────────────────────────────────
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        # Piper uses .onnx voice models — currently no dedicated shared category
        # proxlab_symlink "piper-voices" "$INSTALL_DIR/voices"
    fi

    echo "Piper TTS ${VER} installed to $INSTALL_DIR"
    echo "Voices in: $VOICES_DIR"
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
        if conda run -n "$CONDA_ENV" python3 -c "import piper" 2>/dev/null; then
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
