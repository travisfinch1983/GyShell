#!/bin/bash
# AI-Lab Provider Installer: AI-Lab TTS
# Usage: ./proxlab-tts.sh [install|uninstall|status]
#
# OpenAI-compatible TTS server powered by Chatterbox-Turbo voice cloning.
# Drop-in for SillyTavern (OpenAI TTS provider) and Home Assistant.
# Exposes /v1/audio/speech, /v1/models, /v1/voices, /health.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/proxlab-tts)
#   PROXLAB_CONDA_ENV   - Conda env name (default: proxlab-tts)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/proxlab-tts}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-proxlab-tts}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    if [ -f "$INSTALL_DIR/.version" ] && [ -f "$INSTALL_DIR/server.py" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import chatterbox" 2>/dev/null; then
            echo "AI-Lab TTS already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "AI-Lab TTS version file exists but module missing — reinstalling"
    fi

    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing AI-Lab TTS (Chatterbox-Turbo + OpenAI-compatible API)..."

    # PyTorch cu128. NOT cu124: sm_70 (Volta/V100) is supported through CUDA 12.9 and
    # only removed in 13.0, so cu124 was never a Volta requirement — and cu124 is a
    # dead end, torch 2.6.0 being the last version ever built for it. cu128 covers
    # torch 2.7.0-2.11.0 and is what most third-party wheels target.
    # Verified on a V100 (2026-07-29): sm_70 in arch list, cuDNN conv OK, and both
    # chatterbox engines load and generate audio on 2.9.1+cu128.
    # chatterbox-tts itself declares a bare `torch` dep — this version is our choice.
    conda run -n "$CONDA_ENV" pip install \
        torch==2.9.1 torchaudio==2.9.1 \
        --index-url https://download.pytorch.org/whl/cu128 \
        2>&1

    # Core library (--no-deps to avoid pulling default torch)
    conda run -n "$CONDA_ENV" pip install \
        chatterbox-tts --no-deps \
        2>&1

    # Dependencies
    conda run -n "$CONDA_ENV" pip install \
        transformers==5.2.0 \
        diffusers==0.29.0 \
        librosa==0.11.0 \
        conformer==0.3.2 \
        safetensors==0.5.3 \
        s3tokenizer \
        omegaconf \
        pyloudnorm \
        "numpy<2" \
        spacy-pkuseg \
        pykakasi==2.3.0 \
        "resemble-perth @ git+https://github.com/resemble-ai/Perth.git@master" \
        2>&1

    # API server deps
    conda run -n "$CONDA_ENV" pip install \
        fastapi \
        "uvicorn[standard]" \
        soundfile \
        2>&1

    # ffmpeg for mp3/opus/flac encoding
    conda install -n "$CONDA_ENV" -y -c conda-forge ffmpeg 2>&1

    # Create install dir + voices dir
    mkdir -p "$INSTALL_DIR/voices/default"

    # Write the OpenAI-compatible TTS server (dual-model: Turbo + Original)
    cat > "$INSTALL_DIR/server.py" << 'SERVER_EOF'
"""
AI-Lab TTS — OpenAI-compatible /v1/audio/speech API with dual-model support.

Models:
  chatterbox-turbo  — Fast, high-quality TTS (ResembleAI Chatterbox-Turbo)
  chatterbox        — Original Chatterbox with emotion exaggeration controls

Hot-swap: POST /v1/models/load {"model": "chatterbox"} switches at runtime.

Usage: python server.py [--host 0.0.0.0] [--port 8880] [--voices ./voices]

Endpoints:
  POST   /v1/audio/speech  — Generate speech (OpenAI-compatible)
  GET    /v1/models        — List available TTS models
  POST   /v1/models/load   — Hot-swap the active model
  GET    /v1/voices        — List voice profiles
  POST   /v1/voices        — Upload a new voice profile
  DELETE /v1/voices/{name} — Delete a voice profile
  GET    /health           — Health check
"""
import argparse
import asyncio
import io
import os
import re
import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

# ─── Model registry ─────────────────────────────────────────────────────

MODELS = {
    "chatterbox-turbo": {
        "class": "ChatterboxTurboTTS",
        "module": "chatterbox.tts_turbo",
        "hf_repo": "ResembleAI/chatterbox-turbo",
        "local_dir": "turbo",
    },
    "chatterbox": {
        "class": "ChatterboxTTS",
        "module": "chatterbox.tts",
        "hf_repo": "ResembleAI/chatterbox",
        "local_dir": "original",
    },
}
MODEL_ALIASES = {
    "f5-tts": "chatterbox-turbo",
    "e2-tts": "chatterbox-turbo",
    "tts-1": "chatterbox-turbo",
    "tts-1-hd": "chatterbox-turbo",
}
VALID_FORMATS = {"mp3", "wav", "opus", "flac"}


# ─── Silence trimming ───────────────────────────────────────────────────

def trim_trailing_silence(
    audio: torch.Tensor,
    sample_rate: int,
    threshold_db: float = -40.0,
    tail_ms: int = 150,
) -> tuple[torch.Tensor, float]:
    """
    Trim leading and trailing silence from a torch audio tensor.

    Uses a windowed RMS approach (10ms frames) to detect silence.

    Args:
        audio:         1D or 2D torch tensor (channels x samples, or just samples).
        sample_rate:   Audio sample rate in Hz.
        threshold_db:  Frames with RMS below this (in dB) are considered silence.
        tail_ms:       Keep this many ms of natural decay after last speech frame.

    Returns:
        (trimmed_audio, trimmed_seconds) — the trimmed tensor and how many seconds
        were removed from the tail end.
    """
    # Normalize to 2D (1, samples)
    squeeze_back = False
    if audio.dim() == 1:
        audio = audio.unsqueeze(0)
        squeeze_back = True

    num_samples = audio.shape[-1]
    frame_size = int(sample_rate * 0.010)  # 10ms frames
    if frame_size == 0 or num_samples < frame_size:
        if squeeze_back:
            audio = audio.squeeze(0)
        return audio, 0.0

    # Compute RMS energy per frame (use first channel if multi-channel)
    signal = audio[0].float()
    num_frames = num_samples // frame_size
    # Trim to exact multiple of frame_size for reshape
    trimmed_signal = signal[:num_frames * frame_size]
    frames = trimmed_signal.view(num_frames, frame_size)
    rms = torch.sqrt(torch.mean(frames ** 2, dim=1) + 1e-10)
    rms_db = 20.0 * torch.log10(rms + 1e-10)

    # Find first and last frames above threshold
    above = (rms_db > threshold_db).nonzero(as_tuple=True)[0]
    if len(above) == 0:
        # Entire audio is silence — return as-is
        if squeeze_back:
            audio = audio.squeeze(0)
        return audio, 0.0

    first_frame = above[0].item()
    last_frame = above[-1].item()

    # Leading trim: keep 50ms before first speech frame
    lead_samples = int(sample_rate * 0.050)  # 50ms lead
    start_sample = max(0, first_frame * frame_size - lead_samples)

    # Trailing trim: keep tail_ms after last speech frame
    tail_samples = int(sample_rate * tail_ms / 1000.0)
    end_sample = min(num_samples, (last_frame + 1) * frame_size + tail_samples)

    trimmed = audio[:, start_sample:end_sample]
    trimmed_seconds = (num_samples - trimmed.shape[-1]) / sample_rate

    if squeeze_back:
        trimmed = trimmed.squeeze(0)
    return trimmed, trimmed_seconds


# ─── Globals ─────────────────────────────────────────────────────────────

tts_engine = None
loaded_model: str = ""
voices_dir: Path = Path("./voices")
model_cache_dir: str = "/model-cache/chatterbox"
model_store_dir: str = "/tts/models/chatterbox"
_infer_sem = None  # asyncio.Semaphore(1) — initialized at startup


def resolve_model_path(model_id: str) -> str | None:
    """Check tmpfs cache then NAS for local model weights."""
    local_dir = MODELS[model_id]["local_dir"]
    # 1. Check tmpfs cache
    cache_path = Path(model_cache_dir) / local_dir
    if cache_path.is_dir() and any(cache_path.glob("*.safetensors")):
        return str(cache_path)
    # 2. Check NAS
    nas_path = Path(model_store_dir) / local_dir
    if nas_path.is_dir() and any(nas_path.glob("*.safetensors")):
        return str(nas_path)
    return None


def load_tts(model_id: str = "chatterbox-turbo"):
    """Load (or hot-swap) a TTS model onto the GPU."""
    global tts_engine, loaded_model
    if tts_engine is not None and loaded_model == model_id:
        return

    # Unload current
    if tts_engine is not None:
        del tts_engine
        tts_engine = None
        torch.cuda.empty_cache()
        print(f"Unloaded {loaded_model}")

    info = MODELS[model_id]
    mod = __import__(info["module"], fromlist=[info["class"]])
    cls = getattr(mod, info["class"])

    local_path = resolve_model_path(model_id)
    if local_path:
        print(f"Loading {model_id} from {local_path}...")
        tts_engine = cls.from_local(local_path, device="cuda")
    else:
        print(f"Loading {model_id} from HuggingFace...")
        tts_engine = cls.from_pretrained(device="cuda")

    loaded_model = model_id
    print(f"Model {model_id} loaded and ready")


def get_voice(voice_name: str) -> str:
    """Resolve a voice name to ref_wav_path."""
    vdir = voices_dir / voice_name
    if not vdir.is_dir():
        raise HTTPException(404, f"Voice not found: {voice_name}")
    ref_wav = vdir / "ref.wav"
    if not ref_wav.exists():
        raise HTTPException(404, f"Voice '{voice_name}' missing ref.wav")
    return str(ref_wav)


def resolve_model(name: str) -> str | None:
    """Resolve a model name (or alias) to the canonical model id."""
    lower = name.lower()
    if lower in MODELS:
        return lower
    if lower in MODEL_ALIASES:
        return MODEL_ALIASES[lower]
    return None


def convert_audio(wav_data: np.ndarray, sample_rate: int, fmt: str) -> bytes:
    """Convert numpy audio to the requested format."""
    if fmt == "wav":
        buf = io.BytesIO()
        sf.write(buf, wav_data, sample_rate, format="WAV")
        return buf.getvalue()
    # Use ffmpeg for mp3/opus/flac
    wav_buf = io.BytesIO()
    sf.write(wav_buf, wav_data, sample_rate, format="WAV")
    wav_bytes = wav_buf.getvalue()
    codec_args = {
        "mp3": ["-codec:a", "libmp3lame", "-q:a", "2"],
        "opus": ["-codec:a", "libopus", "-b:a", "64k"],
        "flac": ["-codec:a", "flac"],
    }
    args = codec_args.get(fmt, codec_args["mp3"])
    import sys
    ffmpeg_bin = os.path.join(os.path.dirname(sys.executable), "ffmpeg")
    if not os.path.isfile(ffmpeg_bin):
        ffmpeg_bin = "ffmpeg"
    cmd = [ffmpeg_bin, "-y", "-f", "wav", "-i", "pipe:0",
           *args, "-f", fmt, "pipe:1"]
    proc = subprocess.run(cmd, input=wav_bytes, capture_output=True, timeout=30)
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg failed: {proc.stderr.decode()[:200]}")
    return proc.stdout


MIME_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "opus": "audio/opus",
    "flac": "audio/flac",
}


# ─── FastAPI app ─────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _infer_sem
    _infer_sem = asyncio.Semaphore(1)
    load_tts(app.state.default_model)
    yield

app = FastAPI(title="AI-Lab TTS", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class SpeechRequest(BaseModel):
    model: str = Field(default="chatterbox-turbo", description="TTS model")
    input: str = Field(..., description="Text to synthesize")
    voice: str = Field(default="default", description="Voice profile name")
    response_format: str = Field(default="mp3", description="Output format: mp3, wav, opus, flac")
    speed: float = Field(default=1.0, ge=0.25, le=4.0, description="Accepted for compat, ignored")
    temperature: float = Field(default=0.8, ge=0.05, le=2.0, description="Sampling temperature")
    top_k: int = Field(default=1000, ge=0, description="Top-K sampling (Turbo only)")
    top_p: float = Field(default=0.95, ge=0.0, le=1.0, description="Top-P nucleus sampling")
    repetition_penalty: float = Field(default=1.2, ge=1.0, le=2.0, description="Repetition penalty (1.0 = disabled)")
    # Original-specific params
    exaggeration: float = Field(default=0.5, ge=0.0, le=1.0, description="Emotion exaggeration (Original only)")
    cfg_weight: float = Field(default=0.5, ge=0.0, le=1.0, description="CFG weight (Original only)")
    min_p: float = Field(default=0.05, ge=0.0, le=1.0, description="Min-P sampling (Original only)")
    # Silence trimming params
    trim_silence: bool = Field(default=True, description="Trim trailing silence from generated audio")
    silence_threshold_db: float = Field(default=-40.0, ge=-80.0, le=0.0, description="Silence detection threshold in dB")
    silence_tail_ms: int = Field(default=150, ge=0, le=2000, description="Keep this many ms of silence after last speech")


@app.post("/v1/audio/speech")
async def create_speech(req: SpeechRequest):
    if req.response_format not in VALID_FORMATS:
        raise HTTPException(400, f"Invalid format: {req.response_format}. Use: {VALID_FORMATS}")
    if not req.input.strip():
        raise HTTPException(400, "Input text is empty")

    resolved = resolve_model(req.model)
    if resolved is None:
        raise HTTPException(400, f"Unknown model: {req.model}. Use: {', '.join(MODELS)} (aliases: {', '.join(MODEL_ALIASES)})")

    if req.speed != 1.0:
        print(f"WARNING: speed={req.speed} requested but not supported; ignoring")

    ref_wav = get_voice(req.voice)
    loop = asyncio.get_event_loop()

    global _infer_sem
    if _infer_sem is None:
        _infer_sem = asyncio.Semaphore(1)

    def _generate():
        load_tts(resolved)
        if loaded_model == "chatterbox-turbo":
            wav_tensor = tts_engine.generate(
                text=req.input,
                audio_prompt_path=ref_wav,
                temperature=req.temperature,
                top_k=req.top_k,
                top_p=req.top_p,
                repetition_penalty=req.repetition_penalty,
            )
        else:
            # chatterbox (original)
            wav_tensor = tts_engine.generate(
                text=req.input,
                audio_prompt_path=ref_wav,
                exaggeration=req.exaggeration,
                cfg_weight=req.cfg_weight,
                temperature=req.temperature,
                top_p=req.top_p,
                repetition_penalty=req.repetition_penalty,
                min_p=req.min_p,
            )
        # Trim leading/trailing silence if requested
        if req.trim_silence:
            original_len = wav_tensor.shape[-1]
            wav_tensor, trimmed_secs = trim_trailing_silence(
                wav_tensor, tts_engine.sr,
                threshold_db=req.silence_threshold_db,
                tail_ms=req.silence_tail_ms,
            )
            if trimmed_secs > 0.1:
                print(f"Trimmed {trimmed_secs:.1f}s of trailing silence (was {original_len/tts_engine.sr:.1f}s, now {wav_tensor.shape[-1]/tts_engine.sr:.1f}s)")
        wav_data = wav_tensor.squeeze(0).cpu().numpy()
        sample_rate = tts_engine.sr
        return convert_audio(wav_data, sample_rate, req.response_format)

    async with _infer_sem:
        audio_bytes = await loop.run_in_executor(None, _generate)
    return Response(content=audio_bytes, media_type=MIME_TYPES[req.response_format])


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": mid,
                "object": "model",
                "owned_by": "resemble-ai",
                "active": loaded_model == mid,
            }
            for mid in MODELS
        ],
    }


@app.post("/v1/models/load")
async def load_model_endpoint(body: dict):
    model_id = resolve_model(body.get("model", ""))
    if not model_id or model_id not in MODELS:
        raise HTTPException(400, f"Unknown model: {body.get('model')}. Use: {', '.join(MODELS)}")

    global _infer_sem
    if _infer_sem is None:
        _infer_sem = asyncio.Semaphore(1)

    async with _infer_sem:
        await asyncio.get_event_loop().run_in_executor(None, lambda: load_tts(model_id))
    source = resolve_model_path(model_id) or "huggingface"
    return {"ok": True, "model": model_id, "source": source}


@app.get("/v1/voices")
async def list_voices():
    voices = []
    if voices_dir.is_dir():
        for vdir in sorted(voices_dir.iterdir()):
            ref_wav = vdir / "ref.wav"
            if vdir.is_dir() and ref_wav.exists():
                duration = None
                try:
                    info = sf.info(str(ref_wav))
                    duration = round(info.duration, 1)
                except Exception:
                    pass
                voices.append({
                    "id": vdir.name,
                    "duration": duration,
                    "has_transcript": (vdir / "ref.txt").exists(),
                })
    return {"voices": voices}


@app.post("/v1/voices")
async def upload_voice(
    file: UploadFile = File(...),
    name: str = Form(...),
    transcript: str = Form(""),
):
    if not re.match(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$', name):
        raise HTTPException(400, "Name must be alphanumeric (hyphens/underscores OK)")
    vdir = voices_dir / name
    vdir.mkdir(parents=True, exist_ok=True)
    audio_bytes = await file.read()
    (vdir / "ref.wav").write_bytes(audio_bytes)
    if transcript.strip():
        (vdir / "ref.txt").write_text(transcript.strip())
    elif (vdir / "ref.txt").exists():
        (vdir / "ref.txt").unlink()
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
        "engine": "chatterbox",
        "loaded_model": loaded_model or None,
        "available_models": list(MODELS.keys()),
        "model_loaded": tts_engine is not None,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AI-Lab TTS Server")
    parser.add_argument("--host", "-H", default="0.0.0.0", help="Listen host")
    parser.add_argument("--port", "-p", type=int, default=8880, help="Listen port")
    parser.add_argument("--model", "-m", default="chatterbox-turbo",
                        help="Default model to load at startup")
    parser.add_argument("--voices", "-v", default="./voices", help="Voice profiles directory")
    parser.add_argument("--model-cache", default="/model-cache/chatterbox",
                        help="Local tmpfs cache for model weights")
    parser.add_argument("--model-store", default="/tts/models/chatterbox",
                        help="NAS model store for model weights")
    args = parser.parse_args()

    voices_dir = Path(args.voices)
    model_cache_dir = args.model_cache
    model_store_dir = args.model_store

    # Validate the default model
    default_model = resolve_model(args.model)
    if default_model is None:
        print(f"ERROR: Unknown model '{args.model}'. Available: {', '.join(MODELS)}")
        raise SystemExit(1)
    app.state.default_model = default_model

    uvicorn.run(app, host=args.host, port=args.port)
SERVER_EOF

    # Set up default voice if not already present
    if [ ! -f "$INSTALL_DIR/voices/default/ref.wav" ]; then
        echo "No default voice found — please add a ref.wav to $INSTALL_DIR/voices/default/"
        echo "Existing voice profiles from a previous installation will still work."
    fi

    # Pre-download both Chatterbox models
    echo "Pre-downloading Chatterbox-Turbo model (this may take a few minutes)..."
    conda run -n "$CONDA_ENV" python3 -c "
from chatterbox.tts_turbo import ChatterboxTurboTTS
print('Downloading chatterbox-turbo...')
ChatterboxTurboTTS.from_pretrained(device='cpu')
print('Turbo model cached')
" 2>&1

    echo "Pre-downloading Chatterbox Original model..."
    conda run -n "$CONDA_ENV" python3 -c "
from chatterbox.tts import ChatterboxTTS
print('Downloading chatterbox (original)...')
ChatterboxTTS.from_pretrained(device='cpu')
print('Original model cached')
" 2>&1

    # Get version
    VER=$(conda run -n "$CONDA_ENV" python3 -c "import chatterbox; print(getattr(chatterbox, '__version__', 'unknown'))" 2>/dev/null || echo "unknown")
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher
    cat > "$INSTALL_DIR/serve.sh" << SERVE_EOF
#!/bin/bash
# AI-Lab TTS server — usage: ./serve.sh [--port 8880] [--model chatterbox-turbo]
exec /opt/conda/envs/$CONDA_ENV/bin/python3 "$INSTALL_DIR/server.py" \\
    --host 0.0.0.0 --voices "$INSTALL_DIR/voices" \\
    --model-cache /model-cache/chatterbox \\
    --model-store /tts/models/chatterbox "\$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "AI-Lab TTS (Chatterbox-Turbo) ${VER} installed to $INSTALL_DIR"
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
        if conda run -n "$CONDA_ENV" python3 -c "import chatterbox" 2>/dev/null; then
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
