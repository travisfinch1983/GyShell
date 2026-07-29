#!/bin/bash
# ProxLab Provider Installer: FluxGym
# Flux LoRA training UI — kohya backend, simple workflow, low VRAM
# Default port: 7860

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/fluxgym}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-fluxgym}"
export PATH="/opt/conda/bin:$PATH"

REPO="https://github.com/cocktailpeanut/fluxgym.git"

do_install() {
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/app.py" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        echo "FluxGym already installed: $VER"
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
    # Use Python 3.10 — FluxGym's deps (scipy pinned to older versions) need it
    if ! conda env list 2>/dev/null | grep -qw "^${CONDA_ENV} "; then
        echo "Creating conda environment: $CONDA_ENV (Python 3.10)..."
        conda create -n "$CONDA_ENV" python=3.10 -y 2>&1
    fi


    # Install PyTorch if not present in this env
    if ! conda run -n "$CONDA_ENV" python3 -c "import torch" 2>/dev/null; then
        echo "Installing PyTorch..."
        conda run -n "$CONDA_ENV" pip install torch torchvision torchaudio \
            --index-url https://download.pytorch.org/whl/cu128 2>&1
    fi
    apt-get update -qq 2>/dev/null || true; apt-get install -y -qq libgl1 libglib2.0-0 gfortran libopenblas-dev pkg-config cmake 2>/dev/null || true
    mkdir -p "$INSTALL_DIR"

    echo "Cloning FluxGym..."
    if [ -d "$INSTALL_DIR/.git" ]; then
        cd "$INSTALL_DIR" && git pull 2>&1
    else
        git clone "$REPO" "$INSTALL_DIR" 2>&1
    fi

    cd "$INSTALL_DIR"

    # Pre-install scipy via conda to avoid build-from-source failures
    echo "Installing scipy..."
    conda install -n "$CONDA_ENV" -c conda-forge scipy -y 2>&1 || \
        conda run -n "$CONDA_ENV" pip install --only-binary :all: scipy 2>&1 || \
        conda run -n "$CONDA_ENV" pip install scipy 2>&1

    echo "Installing dependencies (includes kohya sd-scripts)..."
    conda run -n "$CONDA_ENV" pip install -r requirements.txt 2>&1

    VER=$(git describe --tags --always 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
export PATH="/opt/conda/bin:$PATH"
cd "$(dirname "$0")"
exec conda run -n "${PROXLAB_CONDA_ENV:-fluxgym}" \
    python app.py --server-name 0.0.0.0 --server-port "${1:-7860}"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    mkdir -p "$INSTALL_DIR/outputs" "$INSTALL_DIR/datasets"

    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "training-outputs" "$INSTALL_DIR/outputs"
        proxlab_symlink "training-datasets" "$INSTALL_DIR/datasets"
    fi

    echo "FluxGym ${VER} installed to $INSTALL_DIR"
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
    conda run -n "$CONDA_ENV" pip install -r requirements.txt 2>&1
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
    r = urllib.request.urlopen('https://api.github.com/repos/cocktailpeanut/fluxgym/tags', timeout=10)
    tags = json.loads(r.read())
    print(tags[0]['name'] if tags else '')
except: pass
" 2>/dev/null)
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$CURRENT"
    [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ] && echo "PROXLAB_UPDATE_AVAILABLE=$LATEST"
}

do_status() {
    if [ -f "$INSTALL_DIR/app.py" ] && [ -f "$INSTALL_DIR/.version" ]; then
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
