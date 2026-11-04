#!/bin/bash
# claude1 2026-11-03: ONE env recipe per image-to-3D model for every card in the lab (V100 sm_70, 4090 sm_89,
# 5060 Ti sm_120): torch 2.9.1+cu128 (its wheel ships sm_70..sm_120, verified on ai-gpu), xformers for attention
# (flash-attn has no Volta), our CUDA extensions compiled for 7.0;8.6;8.9;12.0 with the CUDA 12.9 toolkit (still
# supports Volta; CUDA 13 drops it). Builds <model>-cu128 NEXT TO the working cu124 envs.
# Usage: build-cu128.sh hunyuan3d21|trellis2|uniforge3d|idol      (uniforge3d clones trellis2-cu128: build that first)
# One step per line: `set -e` doesn't stop inside `a && b` chains.
set -euxo pipefail
M="$1"; E="$M-cu128"; P=/opt/conda/envs/$E/bin
TORCH="torch==2.9.1 torchvision==0.24.1"
IDX=https://download.pytorch.org/whl/cu128
CON=/opt/image3d-envs/constraints-cu128.txt
printf "torch==2.9.1\ntorchvision==0.24.1\n" > $CON
export CUDA_HOME=/opt/cuda-12.9 TORCH_CUDA_ARCH_LIST="7.0;8.6;8.9;12.0" MAX_JOBS=24
export PATH=/opt/cuda-12.9/bin:$PATH
nvcp() { local NV=/opt/conda/envs/$E/lib/python3.10/site-packages/nvidia; export CPATH="$(ls -d $NV/*/include 2>/dev/null | paste -sd:)"; }
ext() { # $1 = src dir
  nvcp
  PATH=$P:$PATH $P/pip install "$1" --no-build-isolation
}

if [ "$M" = uniforge3d ]; then
  [ -x $P/python ] || conda create -y -n $E --clone trellis2-cu128
  $P/pip install "setuptools==80.9.0" wheel packaging "transformers==4.57.3" "peft==0.17.1" "huggingface-hub>=0.36,<1" \
     "timm>=1.0,<2" "kornia>=0.8,<0.9" "numpy>=2.1,<2.3" "Pillow>=10.4,<12" "safetensors>=0.7,<1" "trimesh==4.6.3" \
     "opencv-python-headless>=4.10,<5" "easydict>=1.13,<2" "tqdm>=4.66,<5" "scipy>=1.13,<2" -c $CON
  $P/python -c "import torch, xformers, nvdiffrast.torch, cumesh, flex_gemm, o_voxel, peft; print('import OK', torch.__version__, torch.cuda.get_arch_list())"
  date -Is > /opt/conda/envs/$E/.image3d-ready   # the image3d plugin uses an env only with this marker
echo BUILD-DONE; exit 0
fi

[ -x $P/python ] || conda create -y -n $E python=3.10
$P/pip install $TORCH --index-url $IDX
$P/pip install xformers --index-url $IDX -c $CON
$P/pip install "setuptools<81" ninja wheel -c $CON

case "$M" in
hunyuan3d21)
  # own copy of the repo: custom_rasterizer is an IN-TREE build and the cu124 env's .so lives in /opt/hunyuan3d21
  [ -d /opt/hunyuan3d21-cu128 ] || cp -a /opt/hunyuan3d21 /opt/hunyuan3d21-cu128
  cd /opt/hunyuan3d21-cu128
  grep -vE '^--extra-index-url|^deepspeed|^bpy|^onnxruntime' requirements.txt > /tmp/h3d-req-cu128.txt
  $P/pip install -r /tmp/h3d-req-cu128.txt "onnxruntime==1.20.1" kornia pybind11 -c $CON
  rm -f hy3dpaint/custom_rasterizer/custom_rasterizer_kernel*.so
  nvcp
  ( cd hy3dpaint/custom_rasterizer && PATH=$P:$PATH $P/pip install --no-build-isolation -e . )
  # mesh_inpaint_processor is plain C++ against pybind11 (no torch): the copied py3.10 .so is reused as is
  $P/python -c "import torch, xformers, custom_rasterizer_kernel; print('import OK', torch.__version__, torch.cuda.get_arch_list(), custom_rasterizer_kernel.__file__)"
  ;;
idol)
  cd /opt/idol-sdk
  $P/pip install -e . -c $CON
  $P/python -c "import torch, xformers, idol; from diffusers import AutoencoderKLFlux2; print('import OK', torch.__version__, torch.cuda.get_arch_list())"
  ;;
trellis2)
  cd /opt/trellis2
  $P/pip install imageio imageio-ffmpeg tqdm easydict opencv-python-headless trimesh "transformers==4.57.3" tensorboard pandas lpips zstandard kornia timm -c $CON
  $P/pip install git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8 -c $CON
  B=/opt/image3d-envs/ext-cu128; mkdir -p $B
  [ -d $B/nvdiffrast ] || git clone -b v0.4.0 https://github.com/NVlabs/nvdiffrast.git $B/nvdiffrast
  [ -d $B/nvdiffrec ] || git clone -b renderutils https://github.com/JeffreyXiang/nvdiffrec.git $B/nvdiffrec
  [ -d $B/CuMesh ] || git clone --recursive https://github.com/JeffreyXiang/CuMesh.git $B/CuMesh
  [ -d $B/FlexGEMM ] || git clone --recursive https://github.com/JeffreyXiang/FlexGEMM.git $B/FlexGEMM
  ext $B/nvdiffrast
  ext $B/nvdiffrec
  ext $B/CuMesh
  # FlexGEMM PR #34 (open upstream): explicit_gemm builds im2col in row blocks - without it the V100 path (explicit_gemm)
  # OOMs in the TRELLIS.2 decoder (26 GB on a 32 GB V100). Result identical, peak memory only.
  ( cd $B/FlexGEMM && { git apply --reverse --check /opt/image3d-envs/patches/flexgemm-pr34.diff 2>/dev/null || git apply /opt/image3d-envs/patches/flexgemm-pr34.diff; } )
  ext $B/FlexGEMM
  rm -rf $B/o-voxel; cp -a /opt/trellis2/o-voxel $B/o-voxel; rm -rf $B/o-voxel/build $B/o-voxel/*.egg-info   # own copy: never touch the cu124 build dir
  ext $B/o-voxel
  $P/python -c "import torch, xformers, nvdiffrast.torch, cumesh, flex_gemm, o_voxel; print('import OK', torch.__version__, torch.cuda.get_arch_list())"
  ;;
*) echo "unknown model $M"; exit 2;;
esac
date -Is > /opt/conda/envs/$E/.image3d-ready   # the image3d plugin uses an env only with this marker
echo BUILD-DONE
