#!/bin/bash
# ProxLab Provider Installer: SimpleTuner
# Modern LoRA trainer — 20+ model support (Flux/SDXL/SD3), pip installable
# CLI-only (no web UI)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/simpletuner}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-simpletuner}"
export PATH="/opt/conda/bin:$PATH"

do_install() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import simpletuner" &>/dev/null; then
            echo "SimpleTuner already installed: $VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$VER"
            return 0
        fi
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Create conda env if it doesn't exist
    if ! conda env list 2>/dev/null | grep -qw "^${CONDA_ENV} "; then
        echo "Creating conda environment: $CONDA_ENV (Python 3.12)..."
        conda create -n "$CONDA_ENV" python=3.12 -y 2>&1
    fi


    # Install PyTorch if not present in this env
    if ! conda run -n "$CONDA_ENV" python3 -c "import torch" 2>/dev/null; then
        echo "Installing PyTorch..."
        conda run -n "$CONDA_ENV" pip install torch torchvision torchaudio \
            --index-url https://download.pytorch.org/whl/cu128 2>&1
    fi
    apt-get update -qq 2>/dev/null || true; apt-get install -y -qq libgl1 libglib2.0-0 2>/dev/null || true
    mkdir -p "$INSTALL_DIR"

    echo "Installing SimpleTuner..."
    conda run -n "$CONDA_ENV" pip install 'simpletuner[cuda]' 2>&1

    VER=$(conda run -n "$CONDA_ENV" pip show simpletuner 2>/dev/null | grep -oP '^Version: \K.*' || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    mkdir -p "$INSTALL_DIR/models" "$INSTALL_DIR/output" "$INSTALL_DIR/datasets"

    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "image-checkpoints" "$INSTALL_DIR/models"
        proxlab_symlink "training-outputs" "$INSTALL_DIR/output"
        proxlab_symlink "training-datasets" "$INSTALL_DIR/datasets"
    fi

    echo "SimpleTuner ${VER} installed"
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
    conda run -n "$CONDA_ENV" pip install --upgrade 'simpletuner[cuda]' 2>&1
    NEW_VER=$(conda run -n "$CONDA_ENV" pip show simpletuner 2>/dev/null | grep -oP '^Version: \K.*' || echo "unknown")
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
    r = urllib.request.urlopen('https://pypi.org/pypi/simpletuner/json', timeout=10)
    print(json.loads(r.read())['info']['version'])
except: pass
" 2>/dev/null)
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$CURRENT"
    [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ] && echo "PROXLAB_UPDATE_AVAILABLE=$LATEST"
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ]; then
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
