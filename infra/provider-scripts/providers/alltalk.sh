#!/bin/bash
# ProxLab Provider Installer: AllTalk TTS V2
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./alltalk.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
# AllTalk V2 is a Coqui-based TTS/ASR framework with voice cloning, finetuning,
# RVC voice conversion, and SillyTavern integration. Git-clone based install.
# V2 lives on the 'alltalkbeta' branch of the upstream repo.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/alltalk)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/alltalk}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-alltalk}"
BRANCH="alltalkbeta"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if [ -f "$INSTALL_DIR/tts_server.py" ]; then
            echo "AllTalk TTS V2 already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "AllTalk version file exists but tts_server.py missing — reinstalling"
    fi

    # Verify prereqs
    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing AllTalk TTS V2..."

    # Install system deps: ffmpeg (pydub/audio), espeak-ng (phoneme generation)
    echo "Installing system dependencies..."
    apt-get install -y --no-install-recommends ffmpeg espeak-ng 2>&1 || true

    # Clone or update the repo (V2 = alltalkbeta branch)
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo "Updating existing AllTalk V2 repo..."
        git -C "$INSTALL_DIR" fetch origin "$BRANCH" 2>&1 || true
        git -C "$INSTALL_DIR" checkout "$BRANCH" 2>&1 || true
        git -C "$INSTALL_DIR" pull --ff-only 2>&1 || {
            echo "WARNING: git pull failed, continuing with existing version"
        }
    else
        rm -rf "$INSTALL_DIR"
        echo "Cloning AllTalk TTS V2 (branch: $BRANCH)..."
        git clone --branch "$BRANCH" https://github.com/erew123/alltalk_tts.git "$INSTALL_DIR" 2>&1
    fi

    # Install standalone requirements
    # Must cd into install dir first — requirements reference relative .whl paths
    # like ./system/config/fairseq-*.whl
    echo "Installing AllTalk V2 dependencies..."
    REQS="$INSTALL_DIR/system/requirements/requirements_standalone.txt"
    if [ -f "$REQS" ]; then
        (cd "$INSTALL_DIR" && conda run -n "$CONDA_ENV" pip install -r "$REQS" 2>&1)
        # Pin dependency versions for coqui-tts 0.24.3 + gradio 4.44.1 compatibility:
        #   - transformers<=4.48.3: LogitsWarper base class removed in 4.49+
        #   - huggingface_hub<1.0: gradio 4.44.1 imports HfFolder, removed in 1.0
        conda run -n "$CONDA_ENV" pip install "transformers>=4.43,<=4.48.3" "huggingface_hub<1.0" 2>&1
    else
        echo "WARNING: requirements_standalone.txt not found — trying legacy requirements.txt"
        if [ -f "$INSTALL_DIR/requirements.txt" ]; then
            (cd "$INSTALL_DIR" && conda run -n "$CONDA_ENV" pip install -r "$INSTALL_DIR/requirements.txt" 2>&1)
        fi
    fi

    # Patch config for network access: API on 0.0.0.0:7851, Gradio on :7852
    CONFIG="$INSTALL_DIR/confignew.json"
    if [ -f "$CONFIG" ]; then
        echo "Patching confignew.json for network access (0.0.0.0)..."
        conda run -n "$CONDA_ENV" python3 -c "
import json, pathlib
p = pathlib.Path('$CONFIG')
c = json.loads(p.read_text())
c.setdefault('api_def', {})['api_legacy_ip_address'] = '0.0.0.0'
p.write_text(json.dumps(c, indent=2))
" 2>&1
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
# AllTalk TTS V2 serve wrapper — usage: ./serve.sh
export CUDA_HOME="/opt/conda/envs/${PROXLAB_CONDA_ENV:-alltalk}"
cd "$(dirname "$0")"
exec /opt/conda/envs/${PROXLAB_CONDA_ENV:-alltalk}/bin/python3 script.py "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    # ─── Install Extras (optional, set by ProxLab UI) ────────────────────
    if [[ "${PROXLAB_INSTALL_EXTRAS:-}" == *"rvc"* ]]; then
        echo "Installing RVC extra: faiss-cpu..."
        conda run -n "$CONDA_ENV" pip install faiss-cpu 2>&1
    fi
    if [[ "${PROXLAB_INSTALL_EXTRAS:-}" == *"deepspeed"* ]]; then
        echo "Installing DeepSpeed extra..."
        conda run -n "$CONDA_ENV" pip install deepspeed 2>&1
    fi

    # ─── Download Models (optional, set by ProxLab UI) ─────────────────
    if [[ "${PROXLAB_DOWNLOAD_MODELS:-}" == *"xtts-v2"* ]]; then
        echo "Downloading XTTS v2 model..."
        conda run -n "$CONDA_ENV" python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('coqui/XTTS-v2', local_dir='$INSTALL_DIR/models/xtts/xttsv2_2.0.3')
" 2>&1 || echo "WARNING: XTTS v2 download failed — can be downloaded later from the UI"
    fi

    # ─── Shared Folder Symlinks ──────────────────────────────────────────
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "rvc-models" "$INSTALL_DIR/models/rvc_voices"
        proxlab_symlink "xtts-models" "$INSTALL_DIR/models/xtts"
        proxlab_symlink "tts-outputs" "$INSTALL_DIR/outputs"
    fi

    echo "AllTalk TTS V2 ${VER} installed to $INSTALL_DIR"
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
        if [ -f "$INSTALL_DIR/tts_server.py" ]; then
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
