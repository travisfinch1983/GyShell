#!/bin/bash
# ProxLab Provider Installer: AI-Lab image-gen model services (imagegen-unet / imagegen-te / imagegen-vae)
# One resident model kind per GPU, served to every ComfyUI instance through the comfyui-ailab-pack
# "AI-Lab Remote UNET/CLIP/VAE" nodes (Unix socket in /dev/shm/ailab-modelsvc on the same machine,
# TCP on the service port elsewhere; the same port answers GET /health and /status).
# Default ports: unet 9310, te 9320, vae 9330. Built by claude2; runs in its own conda env (a clone
# of comfyui) and imports comfy from /opt/comfyui.

set -uo pipefail

ACTION="${1:-status}"
# Fixed path: the runner sets PROXLAB_INSTALL_DIR=/opt/<provider id>, but all three ids share one install.
INSTALL_DIR="/opt/ailab-modelsvc"
PY="/opt/conda/envs/ailab-modelsvc/bin/python"

report() {
    if [ ! -f "$INSTALL_DIR/serve.py" ]; then
        echo "ailab-modelsvc not installed: $INSTALL_DIR/serve.py missing"
        echo "PROXLAB_STATUS=not_installed"; return 0
    fi
    if [ ! -x "$PY" ]; then
        echo "ailab-modelsvc conda env missing ($PY)"
        echo "PROXLAB_STATUS=not_installed"; return 0
    fi
    [ -d /opt/comfyui ] || echo "WARNING: /opt/comfyui missing - serve.py imports comfy from it"
    VER=$(md5sum "$INSTALL_DIR/serve.py" | cut -c1-8)
    echo "ailab-modelsvc installed at $INSTALL_DIR (serve.py $VER)"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=serve-$VER"
}

case "$ACTION" in
    status|check-update) report ;;
    install|update)
        # No upstream: claude2 deploys /opt/ailab-modelsvc and the env by hand. Re-run this check after.
        report ;;
    uninstall)
        echo "Refusing to delete $INSTALL_DIR automatically; remove it by hand."
        echo "PROXLAB_STATUS=error" ;;
    *) echo "Unknown action: $ACTION"; echo "PROXLAB_STATUS=error"; exit 1 ;;
esac
