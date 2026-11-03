#!/bin/bash
# claude1 2026-11-03: Hunyuan3D-2.1 env for the ai-epyc 4090 (sm_89). torch 2.5.1+cu124 per upstream README,
# extensions built with /opt/cuda-12.9 (same major as cu124). bpy skipped (gone from PyPI; patch 0002).
# Each step is its own line: `set -e` does NOT stop inside `a && b && c` chains (it ran on past a failed build once).
set -euxo pipefail
cd /opt/hunyuan3d21
[ -x /opt/conda/envs/hunyuan3d21/bin/python ] || conda create -y -n hunyuan3d21 python=3.10
P=/opt/conda/envs/hunyuan3d21/bin
$P/pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124
grep -vE '^--extra-index-url|^deepspeed|^bpy' requirements.txt > /tmp/h3d-req.txt
$P/pip install -r /tmp/h3d-req.txt
# onnxruntime 1.16.3 (pinned) needs an executable stack, which Debian 13 glibc refuses
$P/pip install onnxruntime==1.20.1
# lightning_fabric still imports pkg_resources, which setuptools 81+ removed
$P/pip install "setuptools<81"
export CUDA_HOME=/opt/cuda-12.9 PATH=/opt/cuda-12.9/bin:$P:$PATH TORCH_CUDA_ARCH_LIST="8.9"
# /opt/cuda-12.9 is a minimal toolkit (no cusparse/cusolver headers); torch's own nvidia-* wheels carry them
NV=/opt/conda/envs/hunyuan3d21/lib/python3.10/site-packages/nvidia
export CPATH="$(ls -d $NV/*/include | paste -sd:)"
pushd hy3dpaint/custom_rasterizer
$P/pip install --no-build-isolation -e .
popd
pushd hy3dpaint/DifferentiableRenderer
bash -e compile_mesh_painter.sh
popd
mkdir -p hy3dpaint/ckpt
[ -s hy3dpaint/ckpt/RealESRGAN_x4plus.pth ] || wget -q -O hy3dpaint/ckpt/RealESRGAN_x4plus.pth https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
$P/python -c "import torch, custom_rasterizer_kernel, sys; sys.path.insert(0,'hy3dpaint/DifferentiableRenderer'); import mesh_inpaint_processor; print('extensions import OK')"
echo INSTALL-DONE
