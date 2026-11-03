#!/bin/bash
# claude1 2026-11-03: TRELLIS.2-4B env for the ai-epyc 4090 (sm_89), following upstream setup.sh
# (torch 2.6.0+cu124, py3.10). Extensions built against /opt/cuda-12.9 with CPATH from torch's nvidia-* wheels.
# One step per line: `set -e` does not stop inside `a && b` chains.
set -euxo pipefail
cd /opt/trellis2
[ -x /opt/conda/envs/trellis2/bin/python ] || conda create -y -n trellis2 python=3.10
P=/opt/conda/envs/trellis2/bin
$P/pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
$P/pip install imageio imageio-ffmpeg tqdm easydict opencv-python-headless ninja trimesh transformers gradio==6.0.1 tensorboard pandas lpips zstandard kornia timm "setuptools<81"
# trellis2 walks DINOv3ViTModel.layer; transformers 5.x renamed it (UniForge3D pins the same version)
$P/pip install "transformers==4.57.3"
$P/pip install git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8
$P/pip install https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.3/flash_attn-2.7.3+cu12torch2.6cxx11abiFALSE-cp310-cp310-linux_x86_64.whl
export CUDA_HOME=/opt/cuda-12.9 PATH=/opt/cuda-12.9/bin:$P:$PATH TORCH_CUDA_ARCH_LIST="8.9" MAX_JOBS=32
NV=/opt/conda/envs/trellis2/lib/python3.10/site-packages/nvidia
export CPATH="$(ls -d $NV/*/include | paste -sd:)"
mkdir -p /opt/trellis2/ext
[ -d ext/nvdiffrast ] || git clone -b v0.4.0 https://github.com/NVlabs/nvdiffrast.git ext/nvdiffrast
$P/pip install ext/nvdiffrast --no-build-isolation
[ -d ext/nvdiffrec ] || git clone -b renderutils https://github.com/JeffreyXiang/nvdiffrec.git ext/nvdiffrec
$P/pip install ext/nvdiffrec --no-build-isolation
[ -d ext/CuMesh ] || git clone --recursive https://github.com/JeffreyXiang/CuMesh.git ext/CuMesh
$P/pip install ext/CuMesh --no-build-isolation
[ -d ext/FlexGEMM ] || git clone --recursive https://github.com/JeffreyXiang/FlexGEMM.git ext/FlexGEMM
$P/pip install ext/FlexGEMM --no-build-isolation
$P/pip install ./o-voxel --no-build-isolation
$P/python -c "import torch, flash_attn, nvdiffrast.torch, cumesh, flex_gemm, o_voxel; print('extensions import OK', torch.__version__)"
echo INSTALL-DONE
