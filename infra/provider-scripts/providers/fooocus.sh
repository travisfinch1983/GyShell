#!/bin/bash
# ProxLab Provider Installer: Fooocus
# Simplified Midjourney-like image generation UI — SDXL focus, minimal config
# Default port: 7865

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/fooocus}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-fooocus}"
export PATH="/opt/conda/bin:$PATH"

REPO="https://github.com/lllyasviel/Fooocus.git"

do_install() {
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/entry_with_update.py" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        echo "Fooocus already installed: $VER"
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$VER"
        return 0
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Create conda env if it doesn't exist
    if ! conda env list 2>/dev/null | grep -qw "^${CONDA_ENV} "; then
        echo "Creating conda environment: $CONDA_ENV..."
        conda create -n "$CONDA_ENV" python=3.10 -y 2>&1
    fi

    apt-get update -qq 2>/dev/null || true; apt-get install -y -qq libgl1 libglib2.0-0 2>/dev/null || true

    # Install PyTorch if not present in this env
    if ! conda run -n "$CONDA_ENV" python3 -c "import torch" 2>/dev/null; then
        echo "Installing PyTorch..."
        conda run -n "$CONDA_ENV" pip install torch torchvision torchaudio \
            --index-url https://download.pytorch.org/whl/cu128 2>&1
    fi

    mkdir -p "$INSTALL_DIR"
    if [ -d "$INSTALL_DIR/.git" ]; then
        cd "$INSTALL_DIR" && git pull 2>&1
    else
        git clone "$REPO" "$INSTALL_DIR" 2>&1
    fi

    cd "$INSTALL_DIR"
    echo "Installing Fooocus dependencies..."
    conda run -n "$CONDA_ENV" pip install -r requirements_versions.txt 2>&1

    VER=$(git describe --tags --always 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
export PATH="/opt/conda/bin:$PATH"
cd "$(dirname "$0")"
exec conda run -n "${PROXLAB_CONDA_ENV:-fooocus}" \
    python entry_with_update.py --listen 0.0.0.0 "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    mkdir -p "$INSTALL_DIR/models/checkpoints" "$INSTALL_DIR/models/loras"

    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "image-checkpoints" "$INSTALL_DIR/models/checkpoints"
        proxlab_symlink "image-loras" "$INSTALL_DIR/models/loras"
    fi

    echo "Fooocus ${VER} installed to $INSTALL_DIR"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    if command -v conda &>/dev/null && [ "$CONDA_ENV" != "base" ]; then
        conda env remove -n "$CONDA_ENV" -y 2>/dev/null || true
    fi
    [ -d "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR" && echo "Removed $INSTALL_DIR"
    echo "PROXLAB_STATUS=not_installed"
}

do_update() {
    [ ! -f "$INSTALL_DIR/.version" ] && echo "PROXLAB_STATUS=not_installed" && return 1
    OLD_VER=$(cat "$INSTALL_DIR/.version")
    cd "$INSTALL_DIR" && git pull 2>&1
    conda run -n "$CONDA_ENV" pip install -r requirements_versions.txt 2>&1
    NEW_VER=$(git describe --tags --always 2>/dev/null || echo "unknown")
    echo "$NEW_VER" > "$INSTALL_DIR/.version"
    echo "Updated: $OLD_VER → $NEW_VER"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$NEW_VER"
}

do_check_update() {
    [ ! -f "$INSTALL_DIR/.version" ] && echo "PROXLAB_STATUS=not_installed" && return
    CURRENT=$(cat "$INSTALL_DIR/.version")
    LATEST=$(python3 -c "
import urllib.request, json
try:
    r = urllib.request.urlopen('https://api.github.com/repos/lllyasviel/Fooocus/tags', timeout=10)
    tags = json.loads(r.read())
    print(tags[0]['name'] if tags else '')
except: pass
" 2>/dev/null)
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$CURRENT"
    [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ] && echo "PROXLAB_UPDATE_AVAILABLE=$LATEST"
}

do_status() {
    if [ -f "$INSTALL_DIR/entry_with_update.py" ] && [ -f "$INSTALL_DIR/.version" ]; then
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$(cat "$INSTALL_DIR/.version")"
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
    *) echo "Usage: $0 {install|uninstall|status|update|check-update}"; exit 1 ;;
esac
