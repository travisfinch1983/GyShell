#!/bin/bash
# ProxLab Provider Installer: Dramabox
# Usage: ./dramabox.sh [install|uninstall|status]
#
# Theatrical TTS (Resemble AI Dramabox / IC-LoRA on LTX-2.3 audio DiT).
# Diffusion + flow-matching TTS with Gemma 3 12B text encoder.
# Exposes /generate (Dramabox-native) and /v1/audio/speech (OpenAI-compatible).
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/proxlab-dramabox)
#   PROXLAB_CONDA_ENV   - Conda env name (default: proxlab-dramabox)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/dramabox}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-dramabox}"

# Paths that match the ProxLab convention
DRAMABOX_REPO_DIR="$INSTALL_DIR/DramaBox"
MODEL_STORE="/tts/models/dramabox"
GEMMA_STORE="/tts/models/_hf_cache/unsloth/gemma-3-12b-it-bnb-4bit"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/server.py" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import torch, transformers, peft" 2>/dev/null; then
            echo "Dramabox already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "Dramabox version file exists but env incomplete — reinstalling"
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing Dramabox (theatrical TTS via LTX-2.3 audio DiT + Gemma 3 12B encoder)..."

    # Install PyTorch cu124 first (V100 sm_70 compat — torch 2.8+ drops sm_70)
    conda run -n "$CONDA_ENV" pip install \
        torch==2.6.0 torchaudio==2.6.0 \
        --index-url https://download.pytorch.org/whl/cu124 \
        2>&1

    # Dramabox deps (pinned to versions compatible with torch 2.6 / V100)
    # transformers 4.50 has Gemma3 support; pydantic 2.10.6 avoids gradio's
    # bool-shorthand bug; resemble-perth is the watermark module.
    conda run -n "$CONDA_ENV" pip install \
        pydantic==2.10.6 \
        safetensors \
        accelerate \
        peft \
        av \
        einops \
        PyYAML \
        sentencepiece \
        huggingface_hub \
        soundfile \
        numpy \
        spaces \
        transformers==4.50.0 \
        bitsandbytes \
        gradio==5.7.1 \
        fastapi \
        "uvicorn[standard]" \
        "resemble-perth @ git+https://github.com/resemble-ai/Perth.git@master" \
        2>&1

    # Make sure install dir exists
    mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/voices/default" "$INSTALL_DIR/outputs"

    # Clone (or update) the Dramabox repo
    if [ ! -d "$DRAMABOX_REPO_DIR/.git" ]; then
        echo "Cloning Dramabox repo..."
        git clone https://github.com/resemble-ai/DramaBox "$DRAMABOX_REPO_DIR"
    else
        echo "Updating Dramabox repo..."
        (cd "$DRAMABOX_REPO_DIR" && git pull --ff-only)
    fi

    # ── Apply required patches (see reference_dramabox_setup.md) ─────────

    # Patch 1: inference.py — pass audio_only=True to PromptEncoder
    if grep -q 'use_bnb_4bit=args.bnb_4bit, warm=True)' "$DRAMABOX_REPO_DIR/src/inference.py"; then
        echo "Applying patch 1: inference.py audio_only flag..."
        sed -i 's|use_bnb_4bit=args.bnb_4bit, warm=True)|use_bnb_4bit=args.bnb_4bit, warm=True, audio_only=True)|' \
            "$DRAMABOX_REPO_DIR/src/inference.py"
    fi

    # Patch 2: base_encoder.py — handle multimodal Gemma3 (.language_model)
    ENCODER_PY="$DRAMABOX_REPO_DIR/ltx2/ltx_core/text_encoders/gemma/encoders/base_encoder.py"
    if grep -q '^        outputs = self.model.model(input_ids=input_ids' "$ENCODER_PY"; then
        echo "Applying patch 2: base_encoder.py multimodal Gemma compat..."
        sed -i 's|outputs = self.model.model(input_ids=input_ids|inner = self.model.language_model if hasattr(self.model, "language_model") else self.model.model\n        outputs = inner(input_ids=input_ids|' \
            "$ENCODER_PY"
    fi

    # Patch 3: inference_server.py — pass audio_only=True (same bug, server path)
    if grep -q 'use_bnb_4bit=args.bnb_4bit, warm=True)' "$DRAMABOX_REPO_DIR/src/inference_server.py" 2>/dev/null; then
        echo "Applying patch 3: inference_server.py audio_only flag..."
        sed -i 's|use_bnb_4bit=args.bnb_4bit, warm=True)|use_bnb_4bit=args.bnb_4bit, warm=True, audio_only=True)|' \
            "$DRAMABOX_REPO_DIR/src/inference_server.py"
    fi

    # ── Verify / link Dramabox model weights ─────────────────────────────

    mkdir -p "$MODEL_STORE"
    DIT="$MODEL_STORE/dramabox-dit-v1.safetensors"
    AC="$MODEL_STORE/dramabox-audio-components.safetensors"

    if [ ! -f "$DIT" ] || [ ! -f "$AC" ]; then
        echo "Dramabox weights not found — downloading from HuggingFace..."
        conda run -n "$CONDA_ENV" huggingface-cli download \
            ResembleAI/Dramabox \
            --local-dir "$MODEL_STORE" 2>&1
    else
        echo "Dramabox weights already present at $MODEL_STORE"
    fi

    # ── Download Gemma text encoder (unsloth bnb-4bit, not gated) ────────

    mkdir -p "$GEMMA_STORE"
    if [ ! -f "$GEMMA_STORE/tokenizer.model" ]; then
        echo "Downloading Gemma 3 12B (4-bit, ~8 GB) — first run only..."
        conda run -n "$CONDA_ENV" huggingface-cli download \
            unsloth/gemma-3-12b-it-bnb-4bit \
            --local-dir "$GEMMA_STORE" 2>&1
    else
        echo "Gemma weights already present at $GEMMA_STORE"
    fi

    # ── Write the FastAPI server ─────────────────────────────────────────

    cat > "$INSTALL_DIR/server.py" << 'SERVER_EOF'
"""
Proxlab Dramabox — FastAPI server wrapping the warm TTSServer.

Endpoints:
  POST  /generate          — Dramabox-native (full theatrical params)
  POST  /v1/audio/speech   — OpenAI-compatible (model=dramabox)
  GET   /v1/models
  GET   /v1/voices
  POST  /v1/voices
  DELETE /v1/voices/{name}
  GET   /health
"""
import argparse
import asyncio
import io
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

# Make the Dramabox repo importable
DRAMABOX_REPO = os.environ.get("DRAMABOX_REPO", "/opt/proxlab-dramabox/DramaBox")
sys.path.insert(0, str(Path(DRAMABOX_REPO) / "ltx2"))
sys.path.insert(0, str(Path(DRAMABOX_REPO) / "src"))

# ─── Globals ─────────────────────────────────────────────────────────────

tts_server = None      # the warm TTSServer instance
loaded_dtype: str = "bf16"
voices_dir: Path = Path("./voices")
outputs_dir: Path = Path("./outputs")
_infer_sem = None      # asyncio.Semaphore(1) — single-stream GPU
sample_rate = 48000    # Dramabox native sample rate
VALID_FORMATS = {"mp3", "wav", "opus", "flac"}
MIME_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "opus": "audio/opus",
    "flac": "audio/flac",
}


def load_dramabox(checkpoint, full_checkpoint, gemma_root):
    """Load the warm TTSServer instance."""
    global tts_server, sample_rate
    if tts_server is not None:
        return

    # Patch the env var so TTSServer's auto-discovery finds the Gemma path
    os.environ.setdefault("GEMMA_DIR", str(gemma_root))

    from inference_server import TTSServer
    print(f"Loading Dramabox (checkpoint={checkpoint}, gemma={gemma_root})...")
    tts_server = TTSServer(
        checkpoint=str(checkpoint),
        full_checkpoint=str(full_checkpoint),
        gemma_root=str(gemma_root),
        device="cuda",
        dtype=loaded_dtype,
        compile_model=False,  # skip torch.compile to keep first-call latency predictable
        bnb_4bit=True,
    )
    sample_rate = getattr(tts_server, "sample_rate", 48000)
    print("Dramabox ready")


def resolve_voice(voice_name: str):
    """Return ref.wav path or None for the default-no-ref behavior."""
    if not voice_name or voice_name == "none":
        return None
    vdir = voices_dir / voice_name
    if not vdir.is_dir():
        raise HTTPException(404, f"Voice not found: {voice_name}")
    ref = vdir / "ref.wav"
    if not ref.exists():
        raise HTTPException(404, f"Voice '{voice_name}' missing ref.wav")
    return str(ref)


def convert_audio(wav_data: np.ndarray, sr: int, fmt: str) -> bytes:
    if fmt == "wav":
        buf = io.BytesIO()
        sf.write(buf, wav_data, sr, format="WAV")
        return buf.getvalue()
    wav_buf = io.BytesIO()
    sf.write(wav_buf, wav_data, sr, format="WAV")
    wav_bytes = wav_buf.getvalue()
    codec_args = {
        "mp3": ["-codec:a", "libmp3lame", "-q:a", "2"],
        "opus": ["-codec:a", "libopus", "-b:a", "64k"],
        "flac": ["-codec:a", "flac"],
    }
    args = codec_args.get(fmt, codec_args["mp3"])
    ffmpeg_bin = os.path.join(os.path.dirname(sys.executable), "ffmpeg")
    if not os.path.isfile(ffmpeg_bin):
        ffmpeg_bin = "ffmpeg"
    cmd = [ffmpeg_bin, "-y", "-f", "wav", "-i", "pipe:0",
           *args, "-f", fmt, "pipe:1"]
    proc = subprocess.run(cmd, input=wav_bytes, capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg failed: {proc.stderr.decode()[:200]}")
    return proc.stdout


# ─── App ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _infer_sem
    _infer_sem = asyncio.Semaphore(1)
    load_dramabox(app.state.checkpoint, app.state.full_checkpoint, app.state.gemma_root)
    yield


app = FastAPI(title="Proxlab Dramabox", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class GenerateRequest(BaseModel):
    prompt: str = Field(..., description="Theatrical prompt (dialogue in quotes, stage directions outside)")
    voice: str = Field(default="none", description="Voice profile name (or 'none' to skip ref)")
    response_format: str = Field(default="wav", description="Output format: mp3, wav, opus, flac")
    cfg_scale: float = Field(default=2.5, ge=0.0, le=10.0)
    stg_scale: float = Field(default=1.5, ge=0.0, le=10.0)
    duration_multiplier: float = Field(default=1.1, ge=0.5, le=3.0)
    ref_duration: float = Field(default=10.0, ge=3.0, le=30.0)
    gen_duration: float = Field(default=0.0, ge=0.0, le=120.0,
                                description="Explicit output duration (0 = auto from prompt)")
    seed: int = Field(default=42)
    no_watermark: bool = Field(default=False)


@app.post("/generate")
async def generate(req: GenerateRequest):
    """Dramabox-native generation endpoint."""
    if req.response_format not in VALID_FORMATS:
        raise HTTPException(400, f"Invalid format: {req.response_format}. Use: {VALID_FORMATS}")
    if not req.prompt.strip():
        raise HTTPException(400, "Prompt is empty")

    voice_ref = resolve_voice(req.voice)

    def _generate():
        kwargs = {
            "prompt": req.prompt,
            "cfg_scale": req.cfg_scale,
            "stg_scale": req.stg_scale,
            "duration_multiplier": req.duration_multiplier,
            "seed": req.seed,
        }
        if voice_ref is not None:
            kwargs["voice_ref"] = voice_ref
            kwargs["ref_duration"] = req.ref_duration
        if req.gen_duration > 0:
            kwargs["gen_duration"] = req.gen_duration

        # TTSServer.generate_to_file would write the WAV directly, but we want
        # the bytes in-memory so we use the underlying generate() if available;
        # fall back to file path round-trip otherwise.
        # Always route through generate_to_file — that's where the
        # watermark argument lives upstream.
        tmp_path = outputs_dir / f"_tmp-{os.getpid()}-{int(time.time()*1000)}.wav"
        tts_server.generate_to_file(
            output=str(tmp_path),
            watermark=not req.no_watermark,
            **kwargs,
        )
        wav, sr = sf.read(str(tmp_path))
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return wav, sr

    loop = asyncio.get_event_loop()
    global _infer_sem
    if _infer_sem is None:
        _infer_sem = asyncio.Semaphore(1)

    async with _infer_sem:
        wav, sr = await loop.run_in_executor(None, _generate)

    audio_bytes = convert_audio(wav, sr, req.response_format)
    return Response(content=audio_bytes, media_type=MIME_TYPES[req.response_format])


class SpeechRequest(BaseModel):
    model: str = Field(default="dramabox")
    input: str = Field(..., description="Text (theatrical syntax recommended)")
    voice: str = Field(default="none")
    response_format: str = Field(default="mp3")
    speed: float = Field(default=1.0)  # ignored


@app.post("/v1/audio/speech")
async def openai_speech(req: SpeechRequest):
    """OpenAI-compatible facade — delegates to /generate with sensible defaults."""
    sub = GenerateRequest(
        prompt=req.input,
        voice=req.voice,
        response_format=req.response_format,
    )
    return await generate(sub)


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [{"id": "dramabox", "object": "model", "owned_by": "resemble-ai"}],
    }


@app.get("/v1/voices")
async def list_voices():
    voices = []
    if voices_dir.is_dir():
        for vdir in sorted(voices_dir.iterdir()):
            ref = vdir / "ref.wav"
            if vdir.is_dir() and ref.exists():
                dur = None
                try:
                    dur = round(sf.info(str(ref)).duration, 1)
                except Exception:
                    pass
                voices.append({"id": vdir.name, "duration": dur})
    return {"voices": voices}


@app.post("/v1/voices")
async def upload_voice(file: UploadFile = File(...), name: str = Form(...)):
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$", name):
        raise HTTPException(400, "Name must be alphanumeric (hyphens/underscores OK)")
    vdir = voices_dir / name
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "ref.wav").write_bytes(await file.read())
    return {"ok": True, "voice": name}


@app.delete("/v1/voices/{name}")
async def delete_voice(name: str):
    vdir = voices_dir / name
    if not vdir.is_dir():
        raise HTTPException(404, f"Voice not found: {name}")
    if name == "default":
        raise HTTPException(400, "Cannot delete the default voice")
    shutil.rmtree(vdir)
    return {"ok": True, "deleted": name}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "engine": "dramabox",
        "loaded": tts_server is not None,
        "sample_rate": sample_rate,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Proxlab Dramabox Server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8885)
    parser.add_argument("--voices", default="./voices")
    parser.add_argument("--outputs", default="./outputs")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--full-checkpoint", required=True)
    parser.add_argument("--gemma-root", required=True)
    parser.add_argument("--dtype", default="bf16", choices=["bf16", "fp16"])
    args = parser.parse_args()

    voices_dir = Path(args.voices)
    outputs_dir = Path(args.outputs)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    loaded_dtype = args.dtype
    app.state.checkpoint = args.checkpoint
    app.state.full_checkpoint = args.full_checkpoint
    app.state.gemma_root = args.gemma_root

    uvicorn.run(app, host=args.host, port=args.port)
SERVER_EOF

    # Install ffmpeg into the conda env so the audio re-encoder works
    conda install -n "$CONDA_ENV" -y -c conda-forge ffmpeg 2>&1

    # ── Convenience launcher ─────────────────────────────────────────────

    cat > "$INSTALL_DIR/serve.sh" << SERVE_EOF
#!/bin/bash
# Proxlab Dramabox server
# Usage: ./serve.sh [--port 8885] [other args]
exec /opt/conda/envs/$CONDA_ENV/bin/python3 "$INSTALL_DIR/server.py" \\
    --host 0.0.0.0 \\
    --voices "/tts/voices/f5-tts" \\
    --outputs "$INSTALL_DIR/outputs" \\
    --checkpoint "$MODEL_STORE/dramabox-dit-v1.safetensors" \\
    --full-checkpoint "$MODEL_STORE/dramabox-audio-components.safetensors" \\
    --gemma-root "$GEMMA_STORE" \\
    "\$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    # Record version (Dramabox doesn't ship a version string — use commit SHA)
    VER=$(cd "$DRAMABOX_REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    echo "Proxlab Dramabox $VER installed to $INSTALL_DIR"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    if command -v conda &>/dev/null && [ "$CONDA_ENV" != "base" ]; then
        echo "Removing conda environment: $CONDA_ENV"
        conda env remove -n "$CONDA_ENV" -y 2>/dev/null || true
    fi

    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed $INSTALL_DIR"
    fi
    echo "PROXLAB_STATUS=not_installed"
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import torch, transformers, peft" 2>/dev/null; then
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
