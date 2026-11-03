#!/bin/bash
# claude1 2026-11-03: Idol (speridlabs/idol-sdk) env for the ai-epyc 4090. Pure PyTorch; flash-attn optional (prebuilt wheel).
# Weights: /opt/idol-sdk/ailab-models/idol (symlinks into /imagegen/3d-models/Idol + config.json pointing the
# encoders at the local DINOv3-ViT-H+ and FLUX.2-dev VAE). Run with HF_HUB_OFFLINE=1.
set -euxo pipefail
cd /opt/idol-sdk
[ -x /opt/conda/envs/idol/bin/python ] || conda create -y -n idol python=3.10
P=/opt/conda/envs/idol/bin
$P/pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
# pin torch: an unpinned dependency (tensordict) otherwise drags torch up to the newest release (2.14+cu130)
printf "torch==2.6.0\ntorchvision==0.21.0\n" > /tmp/idol-constraints.txt
$P/pip install -e . -c /tmp/idol-constraints.txt --extra-index-url https://download.pytorch.org/whl/cu124
$P/pip install https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.3/flash_attn-2.7.3+cu12torch2.6cxx11abiFALSE-cp310-cp310-linux_x86_64.whl
$P/python -c "import torch, idol, flash_attn; from diffusers import AutoencoderKLFlux2; print('idol import OK', torch.__version__)"
echo INSTALL-DONE
