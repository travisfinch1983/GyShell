#!/bin/bash
# ProxLab Provider Installer: ComfyUI
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./comfyui.sh [install|uninstall|status|update|check-update]
#
# Node-based image generation workflow UI with extensive custom node ecosystem.
# Default port: 8188
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/comfyui)
#   PROXLAB_CONDA_ENV   - Conda env name (default: comfyui)
#   PROXLAB_INSTALL_EXTRAS - Comma-separated extras (e.g. "manager")

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/comfyui}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-comfyui}"
EXTRAS="${PROXLAB_INSTALL_EXTRAS:-}"

export PATH="/opt/conda/bin:$PATH"

COMFYUI_REPO="https://github.com/comfyanonymous/ComfyUI.git"
MANAGER_REPO="https://github.com/ltdrdata/ComfyUI-Manager.git"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if [ -f "$INSTALL_DIR/main.py" ]; then
            echo "ComfyUI already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "Version file exists but main.py missing — reinstalling"
    fi

    # Verify prereqs
    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Install system dependencies for image processing
    echo "Installing system dependencies..."
    if command -v apt-get &>/dev/null; then

    # PyTorch should already be installed in this env by the pytorch-nvidia
    # prereq step (arch-aware: cu124+torch 2.4.1 on Volta, cu128 latest
    # elsewhere). Surface a clear error rather than installing a hard-coded
    # cu128 that excludes Volta SM 7.0.
    if ! conda run -n "$CONDA_ENV" python3 -c "import torch" 2>/dev/null; then
        echo "ERROR: PyTorch missing from $CONDA_ENV — pytorch-nvidia prereq did not run"
        echo "  Re-run install with the full chain (pytorch-nvidia → comfyui)"
        exit 1
    fi
        apt-get update -qq 2>/dev/null || true
        apt-get install -y -qq libgl1 libglib2.0-0 libsm6 libxrender1 libxext6 2>/dev/null || true
    fi

    mkdir -p "$INSTALL_DIR"

    echo "Cloning ComfyUI..."
    if [ -d "$INSTALL_DIR/.git" ]; then
        cd "$INSTALL_DIR" && git pull 2>&1
    else
        git clone "$COMFYUI_REPO" "$INSTALL_DIR" 2>&1
    fi

    cd "$INSTALL_DIR"

    echo "Installing ComfyUI dependencies..."
    conda run -n "$CONDA_ENV" pip install -r requirements.txt 2>&1

    # Install ComfyUI Manager if requested
    if echo "$EXTRAS" | grep -qi "manager"; then
        echo "Installing ComfyUI Manager..."
        local manager_dir="$INSTALL_DIR/custom_nodes/ComfyUI-Manager"
        if [ -d "$manager_dir/.git" ]; then
            cd "$manager_dir" && git pull 2>&1
        else
            mkdir -p "$INSTALL_DIR/custom_nodes"
            git clone "$MANAGER_REPO" "$manager_dir" 2>&1
        fi
        if [ -f "$manager_dir/requirements.txt" ]; then
            conda run -n "$CONDA_ENV" pip install -r "$manager_dir/requirements.txt" 2>&1
        fi
        cd "$INSTALL_DIR"
    fi

    # Get version
    VER=$(cd "$INSTALL_DIR" && git describe --tags --always 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create launcher script
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
export PATH="/opt/conda/bin:$PATH"
cd "$(dirname "$0")"
exec conda run -n "${PROXLAB_CONDA_ENV:-comfyui}" \
    python main.py --listen 0.0.0.0 "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    # Create model directories
    mkdir -p "$INSTALL_DIR/models/checkpoints"
    mkdir -p "$INSTALL_DIR/models/loras"
    mkdir -p "$INSTALL_DIR/models/embeddings"
    mkdir -p "$INSTALL_DIR/models/controlnet"
    mkdir -p "$INSTALL_DIR/models/vae"
    mkdir -p "$INSTALL_DIR/output"

    echo "ComfyUI ${VER} installed to $INSTALL_DIR"

    # ─── Shared Folder Symlinks ──────────────────────────────────────────
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "image-checkpoints" "$INSTALL_DIR/models/checkpoints"
        proxlab_symlink "image-loras" "$INSTALL_DIR/models/loras"
        proxlab_symlink "image-embeddings" "$INSTALL_DIR/models/embeddings"
        proxlab_symlink "image-controlnet" "$INSTALL_DIR/models/controlnet"
        proxlab_symlink "image-vae" "$INSTALL_DIR/models/vae"
    fi

    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    # Remove the conda environment
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
    echo "Current version: $OLD_VER"

    cd "$INSTALL_DIR"
    echo "Pulling latest changes..."
    if ! git pull --ff-only 2>&1; then
        echo "ERROR: git pull --ff-only failed - divergent/dirty tree or network. NOT updating."
        echo "PROXLAB_STATUS=error"
        echo "PROXLAB_VERSION=$OLD_VER"
        return 1
    fi

    echo "Updating dependencies..."
    conda run -n "$CONDA_ENV" pip install -r requirements.txt 2>&1

    # Update ComfyUI Manager if installed
    if [ -d "$INSTALL_DIR/custom_nodes/ComfyUI-Manager/.git" ]; then
        echo "Updating ComfyUI Manager..."
        cd "$INSTALL_DIR/custom_nodes/ComfyUI-Manager" && git pull --ff-only 2>&1
        if [ -f "requirements.txt" ]; then
            conda run -n "$CONDA_ENV" pip install -r requirements.txt 2>&1
        fi
    fi

    cd "$INSTALL_DIR"
    NEW_VER=$(git describe --tags --always 2>/dev/null || echo "unknown")
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
    # Check latest tag from GitHub API
    LATEST=$(python3 -c "
import urllib.request, json
try:
    r = urllib.request.urlopen('https://api.github.com/repos/comfyanonymous/ComfyUI/tags', timeout=10)
    tags = json.loads(r.read())
    print(tags[0]['name'] if tags else '')
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
    if [ -f "$INSTALL_DIR/main.py" ] && [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
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
