#!/bin/bash
# ProxLab Provider Installer: Dataset Forge (samd)
# SAM + ultralytics detector daemon for AI-Lab: Dataset Review segmentation, detector training,
# and the training-image Auto-crop (/detect). Default port: 8791.
# Code lives in the AI-Lab repo (infra/dataset-forge) and runs in the ComfyUI conda env, which
# already carries torch, segment_anything and ultralytics.

set -uo pipefail

ACTION="${1:-status}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/dataset-forge}"
PY="/opt/conda/envs/comfyui/bin/python"
SAM_CKPT="/imagegen/sam/sam_vit_h_4b8939.pth"

report() {
    if [ ! -f "$INSTALL_DIR/samd.py" ]; then
        echo "dataset-forge not installed: $INSTALL_DIR/samd.py missing"
        echo "PROXLAB_STATUS=not_installed"; return 0
    fi
    if [ ! -x "$PY" ]; then
        echo "ComfyUI conda env missing ($PY) - dataset-forge runs in it"
        echo "PROXLAB_STATUS=error"; return 0
    fi
    [ -f "$SAM_CKPT" ] || echo "WARNING: SAM checkpoint missing at $SAM_CKPT"
    VER=$(md5sum "$INSTALL_DIR/samd.py" | cut -c1-8)
    echo "dataset-forge installed at $INSTALL_DIR (samd.py $VER)"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=samd-$VER"
}

case "$ACTION" in
    status|check-update) report ;;
    install|update)
        # No upstream to clone: the code is part of AI-Lab. Deploy it with
        #   rsync -a /opt/ai-lab/infra/dataset-forge/ root@<container>:/opt/dataset-forge/
        # from CT152, then re-run this check.
        report ;;
    uninstall)
        echo "Refusing to delete $INSTALL_DIR automatically (it holds datasets/run state); remove it by hand."
        echo "PROXLAB_STATUS=error" ;;
    *) echo "Unknown action: $ACTION"; echo "PROXLAB_STATUS=error"; exit 1 ;;
esac
