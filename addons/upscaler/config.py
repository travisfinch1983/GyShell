"""Static configuration. Persistent runtime settings live in the DB."""
import os
from pathlib import Path

# Resolve relative to this file so the service is path-agnostic
APP_DIR = Path(__file__).resolve().parent
DB_PATH = APP_DIR / "state.db"
WORK_DIR = APP_DIR / "work"
TEMPLATES_DIR = APP_DIR / "templates"
STATIC_DIR = APP_DIR / "static"

# Immich connection. Key read at startup from env or file.
IMMICH_URL = os.environ.get("IMMICH_URL", "http://10.0.0.123:2283").rstrip("/")
IMMICH_KEY_FILE = APP_DIR / "immich.key"   # one line: just the API key

def load_immich_key() -> str:
    # Env var wins (handy for systemd EnvironmentFile)
    k = os.environ.get("IMMICH_API_KEY")
    if k:
        return k.strip()
    if IMMICH_KEY_FILE.exists():
        return IMMICH_KEY_FILE.read_text().strip()
    raise RuntimeError(f"Immich API key not found in env IMMICH_API_KEY or {IMMICH_KEY_FILE}")

# Default settings written to DB on first run. User can change via UI.
DEFAULT_SETTINGS = {
    "model": "seedvr2-7b-fp8",                 # non-sharp mixed_block35_fp16
    "proxlab_url": "http://10.0.0.219:17890",  # GPU-inventory base URL — now AI-Lab.
    # Key name kept: app.py, proxlab.py and DashboardView.tsx all read "proxlab_url".
    # The old ProxLab host it was named for is decommissioned and gone.
    "gpu_host_user": "root",
    "gpu_host_script": "/opt/photo-upscale/upscale_pipeline.py",
    "gpu_host_workdir": "/tmp/companion-jobs",
    "min_input_mp": "4.2",
    "poll_interval_sec": "60",
    "worker_enabled": "1",
    "auto_managed_tag": "upscaled",           # tag added to processed (upscaled) assets
    "highres_tag": "upscale-res",             # tag for images already >= MP cutoff (native res, training-ready)
    "history_page_size": "50",                # history entries per page (50/100/250/500/1000/ALL)
    "batch_size": "30",                        # images per pipeline run (1 model-load per batch); 1 = per-image
    # Resident warm-worker server (keeps SeedVR2 in VRAM across jobs):
    "use_resident_server": "0",               # 1 = dispatch via upscale_server.py instead of one-shot
    "upscale_server_port_base": "9700",       # per-GPU port = base + cuda_index
    "upscale_server_idle_timeout": "180",     # server self-exits after this many idle sec (frees VRAM)
    "gpu_host_python": "/opt/photo-upscale/.venv/bin/python",
    "gpu_host_server_script": "/opt/photo-upscale/upscale_server.py",
    # Tag -> training-images one-way sync (download upscaled assets to the NAS):
    "sync_enabled": "1",                       # 1 = watch synced tags and download
    "sync_poll_interval_sec": "300",           # how often the sync loop scans watched tags
    "sync_dest_host": "10.0.0.17",             # NAS host (SSH fallback delivery)
    "sync_dest_root": "/mnt/flashpool/ai-assets/imagegen/training_images",
    # Local-copy mode (preferred): companion bind-mounts Immich storage + dest,
    # so sync copies file->file with no HTTP/SSH. Auto-detected if both dirs exist.
    "sync_local_dest": "/training_images",     # in-container mount of training_images
    "immich_src_root": "/immich-src",          # in-container RO mount of Immich storage
    "immich_upload_prefix": "/opt/immich/upload",  # originalPath prefix to strip
}

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8080
