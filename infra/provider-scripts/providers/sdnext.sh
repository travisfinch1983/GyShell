#!/bin/bash
# ProxLab Provider Installer: SD.Next (Vladmandic)
# A1111 successor — SD/SDXL/SD3/Flux, built-in installer
# Default port: 7860

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/sdnext}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-sdnext}"
export PATH="/opt/conda/bin:$PATH"

REPO="https://github.com/vladmandic/automatic.git"

do_install() {
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/launch.py" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        echo "SD.Next already installed: $VER"
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
        echo "Creating conda environment: $CONDA_ENV (Python 3.10)..."
        conda create -n "$CONDA_ENV" python=3.10 -y 2>&1
    fi


    # PyTorch should already be installed in this env by the pytorch-nvidia
    # prereq step (which is arch-aware: cu124+torch 2.4.1 on Volta, cu128
    # latest elsewhere). If it's missing, surface a clear error rather than
    # falling back to a hard-coded cu128 that breaks Volta GPUs.
    if ! conda run -n "$CONDA_ENV" python3 -c "import torch" 2>/dev/null; then
        echo "ERROR: PyTorch missing from $CONDA_ENV — pytorch-nvidia prereq did not run"
        echo "  Re-run install with the full chain (pytorch-nvidia → sdnext)"
        exit 1
    fi
    apt-get update -qq 2>/dev/null || true; apt-get install -y -qq libgl1 libglib2.0-0 libsm6 libxrender1 libxext6 2>/dev/null || true
    mkdir -p "$INSTALL_DIR"

    echo "Cloning SD.Next..."
    if [ -d "$INSTALL_DIR/.git" ]; then
        cd "$INSTALL_DIR" && git pull 2>&1
    else
        git clone "$REPO" "$INSTALL_DIR" 2>&1
    fi

    cd "$INSTALL_DIR"

    # Use SD.Next's built-in installer with --skip-all to prevent model downloads
    echo "Running SD.Next installer (skip downloads)..."
    conda run -n "$CONDA_ENV" python launch.py --skip-all --test 2>&1 || true

    # Patch get_sd_models() to use sd_checkpoint.checkpoints_list directly.
    # The original endpoint references `sd_models.checkpoints_list`, which is a
    # `from-import` binding that goes stale: list_models() rebinds the dict in
    # sd_checkpoint, but sd_models's reference still points at the original
    # (now-orphan) dict. Result: API returns [] even though the disk scan
    # finds models, and the model browser appears empty in the UI.
    ENDPOINTS_PY="$INSTALL_DIR/modules/api/endpoints.py"
    if [ -f "$ENDPOINTS_PY" ] && grep -q 'for x in sd_models.checkpoints_list.values()' "$ENDPOINTS_PY"; then
        echo "Patching get_sd_models() in endpoints.py (stale-from-import fix)..."
        /opt/conda/envs/"$CONDA_ENV"/bin/python3 - "$ENDPOINTS_PY" << 'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()
old = '''def get_sd_models():
    from modules import sd_models, sd_models_config
    return [{"title": x.title, "model_name": x.name, "filename": x.filename, "type": x.type, "hash": x.shorthash, "sha256": x.sha256, "config": sd_models_config.find_checkpoint_config_near_filename(x)} for x in sd_models.checkpoints_list.values()]'''
new = '''def get_sd_models():
    # ProxLab patch: use sd_checkpoint.checkpoints_list directly.
    # sd_models.checkpoints_list is a stale from-import binding (list_models()
    # rebinds the dict in sd_checkpoint but sd_models keeps its old ref).
    from modules import sd_models_config, sd_checkpoint
    return [{"title": x.title, "model_name": x.name, "filename": x.filename, "type": x.type, "hash": x.shorthash, "sha256": x.sha256, "config": sd_models_config.find_checkpoint_config_near_filename(x)} for x in sd_checkpoint.checkpoints_list.values()]'''
if old in src:
    src = src.replace(old, new)
    with open(path, 'w') as f:
        f.write(src)
    print('  patched')
else:
    print('  pattern not found — skipping (already patched or upstream changed)')
PYEOF
    fi

    VER=$(git describe --tags --always 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# SDNext launcher.
# --skip-all bypasses installer.py's auto-update of diffusers/transformers/etc.
# This is critical on Volta hosts where we pinned diffusers<=0.31 + transformers
# <=4.46 to stay compatible with torch 2.4.1; without --skip-all, sdnext upgrades
# them to dev versions on every launch and breaks at startup with
# `infer_schema(func): Parameter q has unsupported type torch.Tensor`.
#
# PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True switches PyTorch's CUDA
# memory allocator to virtual-address-backed segments that grow on demand,
# reducing fragmentation. Particularly helpful for image-gen workloads with
# wildly varying allocation sizes (base sampling vs hires upscale passes).
export PATH="/opt/conda/bin:$PATH"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
cd "$(dirname "$0")"
exec conda run -n "${PROXLAB_CONDA_ENV:-sdnext}" \
    python launch.py --skip-all --listen --port "${1:-7860}"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "image-checkpoints" "$INSTALL_DIR/models/Stable-diffusion"
        proxlab_symlink "image-loras" "$INSTALL_DIR/models/Lora"
        proxlab_symlink "image-embeddings" "$INSTALL_DIR/models/embeddings"
        proxlab_symlink "image-controlnet" "$INSTALL_DIR/models/ControlNet"
        proxlab_symlink "image-vae" "$INSTALL_DIR/models/VAE"
    fi

    echo "SD.Next ${VER} installed to $INSTALL_DIR"
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
    conda run -n "$CONDA_ENV" python launch.py --skip-all --test 2>&1 || true
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
    r = urllib.request.urlopen('https://api.github.com/repos/vladmandic/automatic/tags', timeout=10)
    tags = json.loads(r.read())
    print(tags[0]['name'] if tags else '')
except: pass
" 2>/dev/null)
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$CURRENT"
    [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ] && echo "PROXLAB_UPDATE_AVAILABLE=$LATEST"
}

do_status() {
    if [ -f "$INSTALL_DIR/launch.py" ] && [ -f "$INSTALL_DIR/.version" ]; then
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
