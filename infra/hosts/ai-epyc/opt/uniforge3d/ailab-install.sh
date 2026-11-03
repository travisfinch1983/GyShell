#!/bin/bash
# claude1 2026-11-03: UniForge3D env = a clone of the trellis2 env (UniForge3D pins the SAME TRELLIS.2 commit
# 75fbf01, torch 2.6.0+cu124, flash-attn 2.7.3, nvdiffrast v0.4.0, CuMesh, FlexGEMM, o-voxel), then its own pins.
# Saves recompiling five CUDA extensions. CuMesh/FlexGEMM are upstream HEAD in trellis2, not its pinned commits;
# rebuild at the pins only if something breaks.
set -euxo pipefail
[ -x /opt/conda/envs/uniforge3d/bin/python ] || conda create -y -n uniforge3d --clone trellis2
P=/opt/conda/envs/uniforge3d/bin
$P/pip install "setuptools==80.9.0" wheel packaging "transformers==4.57.3" "peft==0.17.1" "huggingface-hub>=0.36,<1" \
    "timm>=1.0,<2" "kornia>=0.8,<0.9" "numpy>=2.1,<2.3" "Pillow>=10.4,<12" "safetensors>=0.7,<1" "trimesh==4.6.3" \
    "opencv-python-headless>=4.10,<5" "easydict>=1.13,<2" "tqdm>=4.66,<5" "scipy>=1.13,<2" \
    -c <(printf "torch==2.6.0\ntorchvision==0.21.0\n")
$P/python -c "import torch, flash_attn, nvdiffrast.torch, cumesh, flex_gemm, o_voxel, peft; print('extensions import OK', torch.__version__)"
echo INSTALL-DONE
