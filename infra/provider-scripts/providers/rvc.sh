#!/bin/bash
# AI-Lab Provider Installer: RVC Voice Conversion
# Usage: ./rvc.sh [install|uninstall|status]
#
# Retrieval-based voice conversion. NOT a TTS engine — it re-voices audio a
# TTS instance already produced. The multi-TTS pipeline pairs each RVC
# instance 1:1 with an AI-Lab TTS instance by proxySlot order, so run the
# same number of RVC instances as TTS instances.
#
# Exposes /health, /models, /convert.
#
# Environment variables (set by the AI-Lab installer service):
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/rvc)
#   PROXLAB_CONDA_ENV   - Conda env name (default: rvc)
#
# NOTE ON PINS: fairseq 0.12.2 is the last release that builds against the
# torch/numpy combination infer_rvc_python expects, and it does NOT build on
# Python 3.11+. The env is pinned to Python 3.10 for that reason alone. numpy
# must stay <2 — fairseq and librosa 0.9.1 both break on numpy 2.x.

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/rvc}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-rvc}"
LEGACY_DIR="/opt/proxlab-rvc"

export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Adopt a pre-rename install rather than reinstalling over it.
    if [ -d "$LEGACY_DIR" ] && [ ! -e "$INSTALL_DIR" ]; then
        echo "Migrating legacy install $LEGACY_DIR -> $INSTALL_DIR"
        mv "$LEGACY_DIR" "$INSTALL_DIR"
        ln -s "$INSTALL_DIR" "$LEGACY_DIR"
        echo "Left $LEGACY_DIR as a symlink so existing service scripts keep working."
    fi

    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/server.py" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import infer_rvc_python" 2>/dev/null; then
            echo "AI-Lab RVC already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "AI-Lab RVC version file exists but module missing — reinstalling"
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing AI-Lab RVC (infer_rvc_python + fairseq)..."

    # Python 3.10 is REQUIRED — fairseq 0.12.2 does not build on 3.11+.
    if ! conda env list | grep -qE "^${CONDA_ENV}\s"; then
        conda create -n "$CONDA_ENV" -y python=3.10 2>&1
    fi

    # PyTorch cu124 first (V100 SM70 compat), before anything can pull a
    # default CPU wheel in as a transitive dep.
    conda run -n "$CONDA_ENV" pip install \
        torch==2.6.0 torchaudio==2.6.0 \
        --index-url https://download.pytorch.org/whl/cu124 \
        2>&1

    # fairseq needs these present at build time or its setup.py fails.
    conda run -n "$CONDA_ENV" pip install "pip<24.1" "setuptools<70" wheel cython 2>&1
    conda run -n "$CONDA_ENV" pip install "numpy==1.26.4" 2>&1

    conda run -n "$CONDA_ENV" pip install \
        fairseq==0.12.2 \
        infer_rvc_python==1.2.0 \
        faiss-cpu==1.7.3 \
        librosa==0.9.1 \
        praat-parselmouth==0.4.7 \
        pyworld==0.3.2 \
        torchcrepe==0.0.20 \
        2>&1

    conda run -n "$CONDA_ENV" pip install \
        fastapi \
        "uvicorn[standard]" \
        soundfile \
        2>&1

    mkdir -p "$INSTALL_DIR"

    cat > "$INSTALL_DIR/server.py" << 'RVC_SERVER_EOF'
"""AI-Lab RVC Voice Conversion Service"""

import argparse
import asyncio
import io
import logging
import os
import tempfile
import time
from pathlib import Path

import functools

import numpy as np
import soundfile as sf
import torch
import uvicorn

# Monkey-patch torch.load for fairseq compatibility (PyTorch 2.7+ defaults weights_only=True)
_original_torch_load = torch.load
@functools.wraps(_original_torch_load)
def _patched_torch_load(*args, **kwargs):
    if "weights_only" not in kwargs:
        kwargs["weights_only"] = False
    return _original_torch_load(*args, **kwargs)
torch.load = _patched_torch_load
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from infer_rvc_python import BaseLoader

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("ailab-rvc")

app = FastAPI(title="AI-Lab RVC", version="1.0.0")

# Globals set at startup
rvc_loader: BaseLoader = None
models_dir: Path = None
device_name: str = "unknown"
loaded_tags: list[str] = []
MAX_CACHED_MODELS = 3
inference_lock = asyncio.Semaphore(1)


def scan_models(base_dir: Path) -> dict:
    """Scan models directory for RVC voice models."""
    models = {}
    if not base_dir.exists():
        return models
    for entry in sorted(base_dir.iterdir()):
        if not entry.is_dir():
            continue
        pth_files = list(entry.glob("*.pth"))
        index_files = list(entry.glob("*.index"))
        if pth_files:
            models[entry.name] = {
                "pth": str(pth_files[0]),
                "index": str(index_files[0]) if index_files else "",
            }
    return models


def ensure_model_loaded(model_name: str, f0_method: str, f0_up_key: int,
                        index_rate: float, filter_radius: int,
                        rms_mix_rate: float, protect: float,
                        resample_sr: int = 0):
    """Load a model config into the RVC loader, evicting old ones if needed."""
    global loaded_tags

    models = scan_models(models_dir)
    if model_name not in models:
        raise ValueError(f"Model '{model_name}' not found")

    model_info = models[model_name]
    tag = model_name

    # Evict oldest cached model if at capacity and this is a new model
    if tag not in loaded_tags and len(loaded_tags) >= MAX_CACHED_MODELS:
        evicted = loaded_tags.pop(0)
        if evicted in rvc_loader.model_config:
            del rvc_loader.model_config[evicted]
        logger.info(f"Evicted model config: {evicted}")

    rvc_loader.apply_conf(
        tag=tag,
        file_model=model_info["pth"],
        pitch_algo=f0_method,
        pitch_lvl=f0_up_key,
        file_index=model_info["index"],
        index_influence=index_rate,
        respiration_median_filtering=filter_radius,
        envelope_ratio=rms_mix_rate,
        consonant_breath_protection=protect,
        resample_sr=resample_sr,
    )

    if tag not in loaded_tags:
        loaded_tags.append(tag)


@app.get("/health")
async def health():
    gpu_info = {}
    if torch.cuda.is_available():
        gpu_info = {
            "name": torch.cuda.get_device_name(0),
            "vram_total_mb": round(torch.cuda.get_device_properties(0).total_memory / 1024**2),
            "vram_used_mb": round(torch.cuda.memory_allocated(0) / 1024**2),
            "vram_reserved_mb": round(torch.cuda.memory_reserved(0) / 1024**2),
        }
    model_count = len(scan_models(models_dir))
    return {
        "status": "ok",
        "gpu": gpu_info,
        "cached_models": loaded_tags.copy(),
        "model_count": model_count,
    }


@app.get("/models")
async def list_models():
    models = scan_models(models_dir)
    result = []
    for name, info in models.items():
        result.append({
            "name": name,
            "pth": os.path.basename(info["pth"]),
            "index": os.path.basename(info["index"]) if info["index"] else None,
            "loaded": name in loaded_tags,
        })
    return {"models": result, "count": len(result)}


@app.post("/convert")
async def convert(
    file: UploadFile = File(...),
    model_name: str = Form(...),
    f0_method: str = Form("rmvpe"),
    f0_up_key: int = Form(0),
    index_rate: float = Form(0.75),
    filter_radius: int = Form(3),
    rms_mix_rate: float = Form(0.25),
    protect: float = Form(0.33),
    resample_sr: int = Form(48000),
    output_format: str = Form("wav"),
):
    # Validate params
    if f0_method not in ("rmvpe", "harvest", "crepe", "pm"):
        return JSONResponse(status_code=400, content={"error": f"Invalid f0_method: {f0_method}"})
    if f0_up_key < -12 or f0_up_key > 12:
        return JSONResponse(status_code=400, content={"error": "f0_up_key must be between -12 and 12"})
    if not 0 <= index_rate <= 1:
        return JSONResponse(status_code=400, content={"error": "index_rate must be between 0 and 1"})
    if not 0 <= filter_radius <= 7:
        return JSONResponse(status_code=400, content={"error": "filter_radius must be between 0 and 7"})
    if not 0 <= rms_mix_rate <= 1:
        return JSONResponse(status_code=400, content={"error": "rms_mix_rate must be between 0 and 1"})
    if not 0 <= protect <= 0.5:
        return JSONResponse(status_code=400, content={"error": "protect must be between 0 and 0.5"})
    if resample_sr != 0 and resample_sr < 16000:
        return JSONResponse(status_code=400, content={"error": "resample_sr must be 0 (disabled) or >= 16000"})
    if output_format not in ("wav", "mp3", "flac"):
        return JSONResponse(status_code=400, content={"error": f"Invalid output_format: {output_format}"})

    # Read uploaded audio to temp file (library needs file path for harvest)
    suffix = Path(file.filename).suffix if file.filename else ".wav"
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": f"Failed to read audio: {e}"})

    try:
        # Load model config
        ensure_model_loaded(model_name, f0_method, f0_up_key, index_rate,
                            filter_radius, rms_mix_rate, protect, resample_sr)

        # Run inference with semaphore (not thread-safe)
        async with inference_lock:
            t0 = time.time()
            result = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: rvc_loader.generate_from_cache(
                    audio_data=tmp_path,
                    tag=model_name,
                )
            )
            elapsed = time.time() - t0

        if result is None:
            return JSONResponse(status_code=500, content={"error": "Inference returned no result"})

        # result is (audio_array, sample_rate)
        audio_array, sample_rate = result
        sample_rate = int(sample_rate)
        audio_array = np.asarray(audio_array).flatten()

        # Write output to bytes buffer (PCM_24 for better dynamic range)
        buf = io.BytesIO()
        if output_format == "mp3":
            # soundfile doesn't support mp3 writing, use wav as fallback
            sf.write(buf, audio_array, sample_rate, format="WAV", subtype="PCM_24")
            output_format = "wav"
            media_type = "audio/wav"
        elif output_format == "flac":
            sf.write(buf, audio_array, sample_rate, format="FLAC", subtype="PCM_24")
            media_type = "audio/flac"
        else:
            sf.write(buf, audio_array, sample_rate, format="WAV", subtype="PCM_24")
            media_type = "audio/wav"
        buf.seek(0)

        logger.info(f"Converted with model={model_name} f0={f0_method} "
                     f"key={f0_up_key} sr={sample_rate} resample={resample_sr} "
                     f"in {elapsed:.2f}s")

        return StreamingResponse(
            buf,
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="converted.{output_format}"',
                "X-Inference-Time": f"{elapsed:.3f}",
            },
        )
    except ValueError as e:
        return JSONResponse(status_code=404, content={"error": str(e)})
    except Exception as e:
        logger.exception("Conversion failed")
        return JSONResponse(status_code=500, content={"error": str(e)})
    finally:
        os.unlink(tmp_path)


def main():
    global rvc_loader, models_dir, device_name

    parser = argparse.ArgumentParser(description="AI-Lab RVC Voice Conversion Service")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7100)
    parser.add_argument("--models-dir", default="/tts/models/rvc/checkpoints")
    parser.add_argument("--device", default="cuda:0")
    args = parser.parse_args()

    models_dir = Path(args.models_dir)
    models = scan_models(models_dir)
    logger.info(f"Found {len(models)} RVC voice models in {models_dir}")

    if torch.cuda.is_available():
        device_name = torch.cuda.get_device_name(0)
        logger.info(f"Using GPU: {device_name}")
    else:
        device_name = "cpu"
        logger.warning("No GPU detected, running on CPU")

    rvc_loader = BaseLoader()
    logger.info("RVC BaseLoader initialized")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

RVC_SERVER_EOF

    VER=$(conda run -n "$CONDA_ENV" python3 -c "import infer_rvc_python; print(getattr(infer_rvc_python, '__version__', '1.2.0'))" 2>/dev/null || echo "1.2.0")
    echo "$VER" > "$INSTALL_DIR/.version"

    cat > "$INSTALL_DIR/serve.sh" << SERVE_EOF
#!/bin/bash
# AI-Lab RVC server — usage: ./serve.sh [--port 7100] [--models-dir /tts/models/rvc/checkpoints]
exec /opt/conda/envs/$CONDA_ENV/bin/python3 "$INSTALL_DIR/server.py" \\
    --host 0.0.0.0 --models-dir /tts/models/rvc/checkpoints "\$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    if [ ! -d /tts/models/rvc/checkpoints ]; then
        echo "WARNING: /tts/models/rvc/checkpoints is not mounted — /models will return empty."
        echo "         Expected bind mount -> data/models/rvc/checkpoints"
    fi

    echo "AI-Lab RVC ${VER} installed to $INSTALL_DIR"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    if command -v conda &>/dev/null && [ "$CONDA_ENV" != "base" ]; then
        echo "Removing conda environment: $CONDA_ENV"
        conda env remove -n "$CONDA_ENV" -y 2>/dev/null || true
    fi
    [ -L "$LEGACY_DIR" ] && rm -f "$LEGACY_DIR"
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed $INSTALL_DIR"
    fi
    echo "PROXLAB_STATUS=not_installed"
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import infer_rvc_python" 2>/dev/null; then
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$VER"
        else
            echo "PROXLAB_STATUS=not_installed"
        fi
    else
        echo "PROXLAB_STATUS=not_installed"
    fi
}

# ─── Dispatch ────────────────────────────────────────────────────────────

case "$ACTION" in
    install)   do_install   ;;
    uninstall) do_uninstall ;;
    status)    do_status    ;;
    *)
        echo "Usage: $0 {install|uninstall|status}"
        exit 1
        ;;
esac
