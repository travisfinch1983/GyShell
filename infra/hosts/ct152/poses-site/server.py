#!/usr/bin/env python3
"""poses.deeveeyant.com - read-only, numbered browser for the shared pose library.

Reads /imagegen/pose_library live (poses.json + pose_images/ + mannequin_images/ + skeletons/),
so a pose added in AI-Lab's Pose Manager shows up on the next page load. The number shown on
each tile is the pose's `index` in poses.json - the same number Cinder resolves ("pose 42").
Writes nothing to the library; resized previews are cached under CACHE_DIR.
"""
import io
import json
import logging
import os
import re
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, unquote

from PIL import Image

LIB = os.environ.get("POSE_LIB", "/imagegen/pose_library")
IMAGEGEN = os.path.realpath(os.environ.get("IMAGEGEN_ROOT", "/imagegen"))
CACHE_DIR = os.environ.get("CACHE_DIR", "/var/cache/poses-site")
PORT = int(os.environ.get("PORT", "17895"))
HERE = os.path.dirname(os.path.abspath(__file__))
PREVIEW_W = {"grid": 360, "full": 1400}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("poses-site")
_lock = threading.Lock()
_cache = {"mtime": None, "poses": []}
ID_RE = re.compile(r"^pose_\d{1,5}$")


def load_poses():
    path = os.path.join(LIB, "poses.json")
    m = os.stat(path).st_mtime_ns
    with _lock:
        if _cache["mtime"] != m:
            with open(path) as f:
                _cache["poses"] = json.load(f)
            _cache["mtime"] = m
            log.info("loaded %d poses", len(_cache["poses"]))
        return _cache["poses"]


def source_path(p):
    """Full-size original under /imagegen, or None. Refuses anything that escapes /imagegen."""
    src = p.get("source")
    if not src:
        return None
    full = os.path.realpath(os.path.join(IMAGEGEN, src))
    if not full.startswith(IMAGEGEN + os.sep) or not os.path.isfile(full):
        return None
    return full


def upscaled_path(p):
    f = os.path.join(LIB, "upscaled_images", f"{p['id']}.png")
    return f if os.path.isfile(f) else None


def files_for(p):
    pid = p["id"]
    cand = {
        # full-size source photo > SeedVR2 upscale of the thumbnail > the 224x284 thumbnail itself
        "original": source_path(p) or upscaled_path(p) or os.path.join(LIB, "pose_images", p.get("image") or f"{pid}.webp"),
        "thumb": os.path.join(LIB, "pose_images", p.get("image") or f"{pid}.webp"),
        "mannequin": os.path.join(LIB, "mannequin_images", p.get("mannequin") or f"{pid}.png"),
        "overlay": os.path.join(LIB, "skeletons", f"{pid}_overlay.png"),
        "skeleton": os.path.join(LIB, "skeletons", f"{pid}_skel.png"),
    }
    return {k: v for k, v in cand.items() if v and os.path.isfile(v)}


def public(p):
    f = files_for(p)
    return {
        "n": p.get("index"), "id": p["id"], "name": p.get("name", ""), "category": p.get("category") or "custom",
        "view": p.get("view", ""), "prompt": p.get("prompt", ""),
        "views": [k for k in ("original", "mannequin", "overlay", "skeleton") if k in f],
        "original_kind": "full" if source_path(p) else "upscaled" if upscaled_path(p) else "small",
    }


def preview(path, size):
    """WebP preview no wider than PREVIEW_W[size], cached by source mtime."""
    st = os.stat(path)
    key = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.relpath(path, "/"))
    out = os.path.join(CACHE_DIR, size, f"{key}.{st.st_mtime_ns}.webp")
    if os.path.isfile(out):
        with open(out, "rb") as f:
            return f.read()
    im = Image.open(path)
    im.load()
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA")
    w = PREVIEW_W[size]
    if im.width > w:
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=85)
    data = buf.getvalue()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, out)
    return data


class H(BaseHTTPRequestHandler):
    server_version = "poses-site"

    def log_message(self, fmt, *a):
        log.info("%s %s", self.address_string(), fmt % a)

    def send(self, code, body, ctype, cache=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache or "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path in ("/", "/index.html"):
                with open(os.path.join(HERE, "index.html"), "rb") as f:
                    return self.send(200, f.read(), "text/html; charset=utf-8")
            if path == "/api/poses":
                body = json.dumps([public(p) for p in load_poses()]).encode()
                return self.send(200, body, "application/json")
            if path == "/healthz":
                return self.send(200, f"ok {len(load_poses())} poses".encode(), "text/plain")
            m = re.match(r"^/img/(grid|full)/(original|thumb|mannequin|overlay|skeleton)/(pose_\d{1,5})\.webp$", path)
            if m:
                size, kind, pid = m.groups()
                p = next((x for x in load_poses() if x.get("id") == pid), None)
                f = files_for(p).get(kind) if p else None
                if not f:
                    return self.send(404, b"not found", "text/plain")
                return self.send(200, preview(f, size), "image/webp", cache="private, max-age=300")
            return self.send(404, b"not found", "text/plain")
        except BrokenPipeError:
            pass
        except Exception:
            log.exception("GET %s failed", path)
            try:
                self.send(500, b"internal error", "text/plain")
            except Exception:
                pass


if __name__ == "__main__":
    os.makedirs(CACHE_DIR, exist_ok=True)
    log.info("serving %s on :%d", LIB, PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
