"""
ProxLab Image Browser MCP Server

LoRA training-set dataset management over ProxLab's /api/imagegen API: browse
image folders, manage training/merged sets, crop/reset, generate collages, rate
images (1-10 + comment), auto-caption (WD/JoyTag/BLIP taggers), and edit tags.
Narrowly scoped to the image browser — separate from the general cluster tools.

Dataset lives at training_images/<path>; AI containers see it at
/imagegen/training_images/<path> (returned as agent_path).
"""

import os
import shlex
import subprocess
import shutil
import struct as _struct
import hashlib as _hashlib
import json as _json
import time as _time

import httpx
from mcp.server.fastmcp import FastMCP, Image

PROXLAB_URL = os.environ.get("PROXLAB_URL", "http://127.0.0.1:17890")

mcp = FastMCP(
    "proxlab-image-browser",
    instructions=(
        "ProxLab AI Imagegen dataset tools for building LoRA training sets: list image "
        "folders / training sets / images (resolution + your own ratings only); create, "
        "rename, delete training sets and add/remove images; crop & reset images; generate/"
        "delete labeled collages; rate images 1-10 with comments (one image at a time); "
        "auto-caption with tagger models (WD family / JoyTag / BLIP); write natural-language "
        "captions (.caption). IMPORTANT: there is NO tool to read or edit booru tags — rate "
        "from what you actually SEE in the image, never from tags. Booru .txt tags are managed "
        "outside the toolset (run_tagger generates them; the proxlab Strip Tags button clears "
        "them; open the .txt directly for hand edits). Collages are for navigation/counting, "
        "not for rating. Paths are relative to training_images; agent_path is the /imagegen mount. To SEE an image (required before you rate or caption it) call view_image(path) — it returns the pixels natively into your context; NEVER use read_file / terminal / vision_analyze on agent_path, that mount is not present where you run and will fail."
    ),
)

client = httpx.Client(base_url=PROXLAB_URL, timeout=30.0)
_AGENT_TI = "/imagegen/training_images"
_TI = "training_images"


def _scope(path: str) -> str:
    """Scope an agent-supplied path to the training-images subtree.

    The AI-Lab /api/imagegen/* endpoints are rooted at the WHOLE imagegen tree, so an empty
    path listed 81 folders of models -- checkpoints, loras, vae, text-encoders -- and an agent
    looking for training images had to know to type "training_images/" first. That is how Loom
    ended up wandering the model tree.

    Idempotent, so a path that already carries the prefix (everything list_images returns) is
    passed through unchanged. Accepts the /imagegen mount form too.
    """
    p = (path or "").strip().strip("/")
    # _batches passes through UNSCOPED: UI-assembled training batches live at
    # /imagegen/_batches, and forcing them under training_images/ made every batch
    # there invisible to the curation tools (view_image, collages, removals).
    # RELATIVE, like every _scope return (_TI itself is relative; _abs_under_imagegen
    # joins onto the imagegen root — an absolute return here double-prefixes the path).
    for pre in ("imagegen/_batches", "_batches"):
        if p == pre or p.startswith(pre + "/"):
            return "_batches" + p[len(pre):]
    for pre in ("imagegen/training_images", "training_images"):
        if p == pre:
            return _TI
        if p.startswith(pre + "/"):
            return _TI + "/" + p[len(pre) + 1:]
    if p.startswith("imagegen/"):
        p = p[len("imagegen/"):]
    return f"{_TI}/{p}" if p else _TI
# Longest side served to the agent. Full-res is overkill for rating (some sources are ~9MB)
# and would blow up vision-token / KV cost on long runs.
VIEW_MAXDIM = int(os.environ.get("VIEW_MAXDIM", "1280"))

from urllib.parse import urlencode as _urlencode


def _ig_get(endpoint, **params):
    r = client.get(endpoint, params={k: v for k, v in params.items() if v not in (None, "")})
    r.raise_for_status()
    return r.json()


def _ig_post(endpoint, body):
    r = client.post(endpoint, json=body)
    r.raise_for_status()
    return r.json()


def _j(obj):
    return _json.dumps(obj, indent=2, default=str)


@mcp.tool()
def list_image_folders(path: str = "") -> str:
    """List subfolders under a training_images path, each with its image count.

    Args:
        path: relative folder under training_images ("" = root).
    """
    d = _ig_get("/api/imagegen/browse", path=_scope(path))
    base = (d.get("path") or "").strip("/")
    folders = [{"name": f["name"], "path": (base + "/" + f["name"]).strip("/"),
                "images": f.get("n_images", 0), "subfolders": f.get("n_subfolders", 0),
                "is_training_set": f.get("is_training_set", False),
                "has_training_set": f.get("has_training_set", False)} for f in d.get("folders", [])]
    return _j({"path": base, "folder_count": len(folders),
               "images_here": len(d.get("images", [])), "folders": folders})


@mcp.tool()
def list_training_sets() -> str:
    """List all training sets and merged sets with their image counts and paths."""
    return _j(_ig_get("/api/imagegen/training-sets"))


@mcp.tool()
def list_images(path: str) -> str:
    """List image files in a folder/training set: name, full agent path, type,
    resolution, size, and Cinder's own score/comment if she rated it.

    Deliberately returns NO tag/caption data — tags must never arrive as a side
    effect of looking at images (they bias ratings). There is no tag-read tool at
    all; booru .txt tags live as plain files you can open directly if ever needed.
    Use this listing for navigation + identifying files; rate from the actual image.

    Args:
        path: relative folder under training_images.
    """
    d = _ig_get("/api/imagegen/browse", path=_scope(path))
    base = (d.get("path") or path).strip("/")
    out = []
    for im in d.get("images", []):
        nm = im["name"]
        out.append({"name": nm, "path": f"{base}/{nm}".replace("//", "/"),
                    "agent_path": f"{_AGENT_TI}/{base}/{nm}".replace("//", "/"),
                    "type": nm.rsplit(".", 1)[-1].lower() if "." in nm else "",
                    "w": im.get("w"), "h": im.get("h"), "size": im.get("size"),
                    "cropped": im.get("cropped", False),
                    "score": im.get("score"), "comment": im.get("comment")})
    return _j({"path": base, "count": len(out), "is_training_set": d.get("is_training_set", False),
               "has_collage": d.get("has_collage", False), "images": out})


@mcp.tool()
def view_image(path: str) -> list:
    """Fetch a training image and the vision_url you need in order to SEE it.

    READ THIS BEFORE RATING OR CAPTIONING ANYTHING.

    This tool does NOT put the pixels in your context. It cannot. Hermes converts every image
    an MCP tool returns into a ``MEDIA:<path>`` TEXT string (mcp_tool.py), and a tool result is
    a plain string with no place to carry an image. The ``MEDIA:`` line you see in the result
    means the picture was delivered to TRAVIS'S CHAT so a human can look at it. It is not
    delivered to you, and its presence is not evidence that you can see anything.

    TO ACTUALLY SEE THE IMAGE, CALL:

        vision_analyze(image_url=<the MEDIA: path from THIS result>, question="<what you need>")

    Pass the MEDIA: path — the local .webp in your profile's image cache — NOT the vision_url.
    vision_analyze refuses the vision_url because it points at 127.0.0.1 and private addresses are
    blocked as unsafe. The vision_url is kept so a human can open the image.

    vision_analyze is a NATIVE HERMES TOOL. It will NOT appear in your MCP tool catalogue
    alongside these image tools — looking for it there and not finding it does not mean it was
    removed. On a vision-capable main model it routes the image to YOUR OWN model, so you see
    the real pixels rather than another model's description.

    Pass the vision_url, never agent_path — that /imagegen mount does not exist where you run.

    If you have not called vision_analyze, you have not seen the image. Rating or captioning at
    that point would be fabrication, however confident the reasoning feels. Say you cannot see
    it instead.

    AND ONCE YOU CAN SEE IT: describe only what is verifiably in the pixels. The folder name is
    not evidence. An agent looking at satin-1.png in a folder called "satin" reported "shiny red
    satin" when the image showed multicoloured confetti print — real pixels, wrong description,
    because expectation filled in for observation. If a detail would read the same whether or not
    you had actually looked, do not state it.

    Returns two blocks: the image (for Travis's chat) and a JSON block with:
      vision_url  — pass this to vision_analyze
      source_w/h  — the ORIGINAL pixel dimensions
      view_w/h    — the dimensions vision_analyze will see
      scale       — view / source. Prefer crop_image's normalized center_nx/center_ny/size_frac.

    Args:
        path: the image's `path` from list_images. Paths are relative to training_images and
              the prefix is optional — 'satin/satin-1.png' and
              'training_images/satin/satin-1.png' both work. agent_path works too.
    """
    # ⚠ DO NOT strip a leading "training_images/" here.
    # Every /api/imagegen/* endpoint on the AI-Lab backend is rooted at the WHOLE imagegen
    # tree, not at training_images -- verified: image?path=training_images/satin/satin-1.png
    # -> 200, image?path=satin/satin-1.png -> 404. list_images() returns paths WITH the
    # prefix, so stripping it here meant an agent could list images and then never open one:
    # every view_image 404'd. That is what sent Loom to a browser tool and a hand-rolled HTTP
    # server -- not a missing tool, a tool whose two halves disagreed about the root.
    # Only the /imagegen mount prefix (the agent_path form) is removed.
    rel = _scope(path)
    params = {"path": rel, "maxdim": VIEW_MAXDIM}
    r = client.get("/api/imagegen/image", params=params)
    r.raise_for_status()
    # /image?maxdim= returns webp downscaled to <=VIEW_MAXDIM longest side — keeps vision-token / KV
    # cost sane so long rating runs do not balloon the agent context (full-res is overkill to rate).
    vision_url = f"{PROXLAB_URL}/api/imagegen/image?{_urlencode(params)}"

    sw, sh = _source_dims(rel)
    meta = {"vision_url": vision_url,
            "next_step": "You have NOT seen this image yet. Call the NATIVE tool vision_analyze — it is not in the MCP catalogue with these tools, which is expected. PASS THE MEDIA: PATH PRINTED ABOVE (a local .webp in your profile cache), NOT the vision_url: that url points at 127.0.0.1 and vision_analyze refuses private addresses as unsafe. Use the MEDIA path from THIS call, not one earlier in your context. Then describe only what is verifiably in the pixels — the folder name is not evidence."}
    if sw and sh:
        sw, sh = int(sw), int(sh)
        f = min(1.0, VIEW_MAXDIM / float(max(sw, sh)))
        meta.update({"source_w": sw, "source_h": sh,
                     "view_w": int(round(sw * f)), "view_h": int(round(sh * f)),
                     "scale": round(f, 4),
                     "note": ("you are viewing a downscaled copy; crop_image takes NORMALIZED "
                              "center_nx/center_ny/size_frac (0..1) so you never have to convert")})
    # Two content blocks: the image (the runtime renders it to the user's chat) and the JSON.
    return [Image(data=r.content, format="webp"), _j(meta)]


@mcp.tool()
def create_training_set(folder: str, suffix: str, files: list[str]) -> str:
    """Create a training set under <folder>/training_set_<suffix> by copying the
    named images from <folder> into it (renamed <suffix>-N, with reset baselines).

    Args:
        folder: source folder (relative) holding the images.
        suffix: name for the set (becomes training_set_<suffix>).
        files: image filenames in <folder> to include.
    """
    return _j(_ig_post("/api/imagegen/send-to-training-set", {"path": _scope(folder), "suffix": suffix, "files": files}))


@mcp.tool()
def add_images_to_training_set(src_folder: str, set_path: str, files: list[str]) -> str:
    """Copy images from a source folder into an existing training set (renamed to
    the set's <base>-N scheme).

    Args:
        src_folder: folder (relative) containing the images.
        set_path: destination training set (relative).
        files: image filenames in src_folder to copy.
    """
    return _j(_ig_post("/api/imagegen/transfer", {"op": "copy", "src": _scope(src_folder), "dest": _scope(set_path), "files": files}))


@mcp.tool()
def remove_images_from_training_set(set_path: str, files: list[str]) -> str:
    """Delete specific images (with caption/baseline/rating) from a training set.

    Args:
        set_path: the training set (relative).
        files: image filenames to remove.
    """
    return _j(_ig_post("/api/imagegen/delete", {"path": _scope(set_path), "files": files}))


@mcp.tool()
def rename_training_set(path: str, suffix: str) -> str:
    """Rename a training set's suffix (training_set_<old> -> training_set_<suffix>).

    Args:
        path: the training set (relative).
        suffix: new suffix.
    """
    return _j(_ig_post("/api/imagegen/rename-set", {"path": _scope(path), "suffix": suffix}))


@mcp.tool()
def delete_training_set(path: str) -> str:
    """Delete an entire training set (the folder and all its contents).

    Args:
        path: the training set (relative).
    """
    return _j(_ig_post("/api/imagegen/delete-set", {"path": _scope(path)}))


# Square crops only, normalized to this edge length. LoRA training sets are
# 1:1 at 1024px; the tool intentionally cannot produce any other aspect ratio
# or output size, so an agent can never emit a non-square / non-1024 crop.
_CROP_OUT = 1024


def _source_dims(path: str):
    """Return (w, h) of a training-set image by browsing its parent folder.
    Returns (None, None) if the file/dims can't be resolved."""
    rel = path.strip("/")
    folder, _, name = rel.rpartition("/")
    try:
        d = _ig_get("/api/imagegen/browse", path=_scope(folder))
    except Exception:
        return (None, None)
    for im in d.get("images", []):
        if im.get("name") == name:
            return (im.get("w"), im.get("h"))
    return (None, None)


@mcp.tool()
def crop_image(path: str, center_x: int = -1, center_y: int = -1, size: int = 0,
               center_nx: float = -1.0, center_ny: float = -1.0,
               size_frac: float = 0.0) -> str:
    """Crop a training-set image to a SQUARE and normalize it to 1024x1024.

    Think of a square viewfinder over the source image. You choose WHERE to center it
    and HOW BIG it is (in SOURCE pixels). The crop is ALWAYS 1:1 and the output is
    ALWAYS 1024x1024 — you cannot produce any other aspect ratio or output size, so a
    crop can never come out as a random rectangle. Non-destructive (reset_image undoes).

    COORDINATE SPACE — USE THE NORMALIZED ARGS. The image you look at via vision_analyze
    is DOWNSCALED from the original, so any x/y you eyeball off it is in the wrong scale
    (e.g. a 2048x2728 source shown at 961x1280 is off by ~2.13x). Normalized coordinates
    are fractions of the image, so they mean the same thing at any resolution and need no
    conversion — aim with these and the mismatch cannot happen:

        center_nx / center_ny : 0..1 fraction of width / height (0.5,0.5 = dead centre)
        size_frac             : 0..1 fraction of the SHORTER edge (1.0 = biggest square that fits)

    The pixel args (center_x/center_y/size) still work and are ALWAYS in the image's
    ORIGINAL/source pixels (the w/h list_images reports) — only use them if you got the
    numbers from list_images, never from eyeballing a view. Normalized args win when both
    are supplied.

    Args:
        path: image file (relative, inside a training set).
        center_x: x (SOURCE pixels) to center on. Omit / -1 to center horizontally.
        center_y: y (SOURCE pixels) to center on. Omit / -1 to center vertically.
        size: side length in SOURCE pixels. BIGGER = more of the image (zoom out);
              SMALLER = tighter (zoom in). Omit / 0 = largest square that fits.
        center_nx: PREFERRED. x as a 0..1 fraction of width — put this on the subject.
        center_ny: PREFERRED. y as a 0..1 fraction of height.
        size_frac: PREFERRED. square side as a 0..1 fraction of the shorter edge.

    Guards you cannot break:
      * always 1:1, always 1024x1024 output;
      * NO UPSCALING — size is floored at 1024 source px (a smaller region would have to
        be enlarged to reach 1024). If the image's shorter edge is < 1024, the whole
        shorter edge is used (the only unavoidable upscale case);
      * the square is clamped fully inside the image (center is pulled in as needed).
    """
    try:
        center_x = int(center_x)
        center_y = int(center_y)
        size = int(size)
        center_nx = float(center_nx)
        center_ny = float(center_ny)
        size_frac = float(size_frac)
    except (TypeError, ValueError):
        return _j({"error": "center_x/center_y/size must be ints (source px); "
                            "center_nx/center_ny/size_frac must be numbers in 0..1."})

    w, h = _source_dims(path)

    # Normalized coords are resolution-independent, so what was aimed at on the downscaled
    # view maps onto the original with no conversion. They take precedence over the pixel
    # args precisely so a stale pixel value can never silently win.
    _norm_used = (center_nx >= 0) or (center_ny >= 0) or (size_frac > 0)
    if _norm_used:
        if not (w and h):
            return _j({"error": "cannot resolve normalized coords: source dimensions unavailable "
                                "for this image; pass source-pixel center_x/center_y/size instead."})
        _W, _H = int(w), int(h)
        for _n, _v in (("center_nx", center_nx), ("center_ny", center_ny), ("size_frac", size_frac)):
            if _v > 1.0:
                return _j({"error": f"{_n} must be a fraction in 0..1, got {_v}."})
        if center_nx >= 0:
            center_x = int(round(center_nx * _W))
        if center_ny >= 0:
            center_y = int(round(center_ny * _H))
        if size_frac > 0:
            size = int(round(size_frac * min(_W, _H)))
    if w and h:
        w, h = int(w), int(h)
        short = min(w, h)
        # size: default = largest square that fits; clamp to <= shorter edge and
        # >= 1024 (no upscaling), but never above the shorter edge.
        if size <= 0:
            size = short
        size = min(size, short)
        size = max(size, min(_CROP_OUT, short))
        # center: default = image center; then clamp the square fully in-bounds.
        if center_x < 0:
            center_x = w // 2
        if center_y < 0:
            center_y = h // 2
        left = max(0, min(center_x - size // 2, w - size))
        top = max(0, min(center_y - size // 2, h - size))
    else:
        # Dims unknown (couldn't browse the folder): still guarantee a square >= 1024
        # (no upscale) centered at the requested point (default top-left).
        if size <= 0:
            size = _CROP_OUT
        size = max(size, _CROP_OUT)
        left = max(0, center_x - size // 2) if center_x >= 0 else 0
        top = max(0, center_y - size // 2) if center_y >= 0 else 0

    return _j(_ig_post("/api/imagegen/crop", {
        "path": _scope(path), "left": left, "top": top,
        "width": size, "height": size,
        "target_w": _CROP_OUT, "target_h": _CROP_OUT,
    }))


@mcp.tool()
def reset_image(path: str) -> str:
    """Restore a training-set image to its pristine original (undo crops/upscales).

    Args:
        path: image file (relative, inside a training set).
    """
    return _j(_ig_post("/api/imagegen/reset-crop", {"path": _scope(path)}))


@mcp.tool()
def generate_collage(path: str) -> str:
    """Build a numbered contact-sheet collage of a training set (each cell labeled
    with the image's number). Saved as _collage.jpg; returns its agent_path.

    Args:
        path: the training set (relative).
    """
    return _j(_ig_post("/api/imagegen/collage", {"path": _scope(path)}))


@mcp.tool()
def delete_collage(path: str) -> str:
    """Delete a folder's _collage.jpg.

    Args:
        path: the folder/training set (relative).
    """
    return _j(_ig_post("/api/imagegen/collage-delete", {"path": _scope(path)}))


@mcp.tool()
def rate_image(folder: str, file: str, score: int, comment: str = "") -> str:
    """Set Cinder's trainability rating (1-10) and comment for an image. Stored in
    the folder's _ratings.json, pruned automatically if the image is deleted.
    Pass score=0 to clear the rating.

    Args:
        folder: the folder/training set (relative) containing the image.
        file: image filename.
        score: 1-10 (0 to clear).
        comment: optional note.
    """
    return _j(_ig_post("/api/imagegen/rating",
              {"path": _scope(folder), "file": file, "score": (None if score == 0 else score), "comment": comment}))

# --- Ultra-Coder 2026-07-02: sanitize ratings payload at this boundary ---
# The AI-Lab /api/imagegen/ratings backend (127.0.0.1:17890) includes collage
# artifacts (e.g. _collage.jpg / .collage.jpg) in `unscored` and counts them in
# `total`. list_images (via /browse) filters these out; the ratings endpoint
# does NOT, so an agent's unscored queue got polluted with a collage it could
# mistakenly try to rate, and scored/total math was off by the collage file(s).
# Filter to real, rateable training images here and recompute total. The true
# fix belongs in the AI-Lab backend too (flagged to claude1); this keeps the
# tool correct regardless.
_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


def _is_real_image(name: str) -> bool:
    low = name.lower()
    if low.startswith(".") or low.startswith("_") or "collage" in low:
        return False
    return os.path.splitext(low)[1] in _IMG_EXTS


def _sanitize_ratings(d: dict) -> dict:
    if not isinstance(d, dict):
        return d
    unscored = [n for n in d.get("unscored", []) if _is_real_image(n)]
    d["unscored"] = unscored
    scored = d.get("scored")
    if scored is None:
        scored = len(d.get("ratings", {}) or {})
    d["scored"] = scored
    d["total"] = scored + len(unscored)
    return d
# --- end Ultra-Coder patch ---


@mcp.tool()
def get_ratings(folder: str) -> str:
    """Get all of Cinder's ratings for a folder plus the list of unscored images.

    Args:
        folder: the folder/training set (relative).
    """
    return _j(_sanitize_ratings(_ig_get("/api/imagegen/ratings", path=_scope(folder))))


@mcp.tool()
def list_unscored_images(folder: str) -> str:
    """List images in a folder Cinder hasn't rated yet.

    Args:
        folder: the folder/training set (relative).
    """
    d = _sanitize_ratings(_ig_get("/api/imagegen/ratings", path=_scope(folder)))
    return _j({"path": folder, "unscored": d.get("unscored", []),
               "scored": d.get("scored", 0), "total": d.get("total", 0)})


@mcp.tool()
def list_taggers() -> str:
    """List available auto-caption models (WD tagger family, JoyTag, BLIP)."""
    return _j(_ig_get("/api/imagegen/taggers"))


@mcp.tool()
def run_tagger(path: str, model: str, engine: str = "onnx", device: str = "cpu",
               threshold: float = 0.35, char_threshold: float = 0.85, trigger: str = "",
               spaces: bool = False, overwrite: bool = False, wait: bool = True) -> str:
    """Auto-caption every image in a folder/training set. WD/JoyTag (engine=onnx)
    write booru tags to .txt; BLIP (engine=blip) writes a natural-language caption
    to .caption — so both can co-exist on the same images. Runs on ai-epyc.
    Use list_taggers() to pick a model.

    Args:
        path: the folder/training set (relative).
        model: tagger id from list_taggers (e.g. wd-eva02-large-tagger-v3, joytag, blip-large).
        engine: "onnx" (WD/JoyTag tags) or "blip" (natural-language caption).
        device: "cpu" or "cuda" (cuda = the 4090; BLIP always uses cuda).
        threshold: general tag confidence (ONNX, default 0.35).
        char_threshold: character tag confidence (ONNX, default 0.85).
        trigger: optional tag(s)/word prepended to every caption.
        spaces: convert underscores to spaces in tags.
        overwrite: re-caption images that already have a .txt (else skip).
        wait: block until the job finishes and return its result (default True).
    """
    body = {"path": path, "model": model, "engine": engine, "device": device,
            "threshold": threshold, "char_threshold": char_threshold, "trigger": trigger,
            "spaces": spaces, "overwrite": overwrite}
    r = _ig_post("/api/imagegen/auto-caption", body)
    job = r.get("jobId")
    if not job:
        return _j(r)
    if not wait:
        return _j({"jobId": job, "state": "started"})
    # Return BEFORE the MCP gateway's 60s budget: small sets finish here; large
    # sets come back with the jobId to poll via tagger_status (no gateway timeout).
    for _ in range(15):                  # ~45s
        _time.sleep(3)
        s = _ig_get("/api/imagegen/auto-caption-status", jobId=job)
        if s.get("state") != "running":
            return _j(s)
    return _j({"jobId": job, "state": "running",
               "note": "large set still tagging — call tagger_status('" + str(job) + "') to track it to completion"})


@mcp.tool()
def tagger_status(job_id: str) -> str:
    """Check an auto-caption job's progress/result (for jobs started with wait=False).

    Args:
        job_id: the jobId returned by run_tagger.
    """
    return _j(_ig_get("/api/imagegen/auto-caption-status", jobId=job_id))


@mcp.tool()
def get_caption(path: str) -> str:
    """Read an image's natural-language caption (the .caption sidecar). Booru tags
    (.txt) are intentionally NOT accessible through any tool — rate from what you
    SEE in the image, not from tags. If you ever genuinely need the booru tags, open
    the image's .txt file directly with normal file tools.

    Args:
        path: image file (relative).
    """
    return _j(_ig_get("/api/imagegen/caption", path=_scope(path), ext="caption"))


@mcp.tool()
def set_caption(path: str, caption: str) -> str:
    """Write/replace an image's natural-language caption (the .caption sidecar; empty
    string removes it). Only touches .caption — booru tags (.txt) are managed outside
    the toolset (run_tagger generates them; the proxlab Strip Tags button clears them;
    hand-edit via direct file ops).

    Args:
        path: image file (relative).
        caption: natural-language caption text.
    """
    return _j(_ig_post("/api/imagegen/caption", {"path": _scope(path), "caption": caption, "ext": "caption"}))


@mcp.tool()
def comfyui_instances() -> str:
    """List every running ComfyUI server on the cluster so you can choose which one to use.

    Returns, per instance: container, url (ip:port to send workflows to), status, and the
    GPUs ASSIGNED TO IT AT LAUNCH (with model, arch, and live VRAM). These GPUs are
    AUTHORITATIVE. ComfyUI's own /system_stats only ever reports GPU 0 — so NEVER decide GPU
    count from /system_stats, and NEVER add GPUs or restart a container because it "only shows
    one GPU": the GPUs in this tool's output are what the instance actually has.

    Choosing an instance — match the GPU to the job:
      - Large / high-VRAM models (e.g. LTX 2.3 and other video, big SDXL or FLUX workflows) ->
        use an instance on the V100 rig (32 GB per GPU, more headroom).
      - Smaller / lighter models -> use an instance on a newer, lower-VRAM GPU (e.g. the 4090)
        for faster generation.
      - When two instances both fit, prefer the one with the most free VRAM (vram_available_mb).

    Call this first whenever you're about to run a ComfyUI workflow; the instance list changes
    as servers are launched or stopped, so don't hardcode a host.
    """
    return _j(_ig_get("/api/ai/comfyui-instances"))




# ══════════════════════════════════════════════════════════════════════════════
# Tool Set A — training_batch creator (Loom's LoRA pipeline, 2026-09-02)
#
# A training_batch is the curated PICK, assembled for a trainer. It is derived from a
# training set, never the set itself: the set stays the source of truth so a batch can be
# rebuilt, re-picked or thrown away without touching curation work.
#
# Sidecars travel with the image, because a trainer reads them by filename convention:
#   .txt      booru tags  — what kohya reads. MISSING = the image trains UNLABELED.
#   .caption  natural language — used by some trainers, carried along regardless.
# ══════════════════════════════════════════════════════════════════════════════

# The image library, as seen from THIS container (CT152). The rest of this server talks to
# AI-Lab HTTP API, but assembling a batch is a pure file operation — copying images and their
# sidecars — and doing it directly is both simpler and less likely to half-succeed than a
# sequence of API round-trips. _scope() already yields paths relative to this root.
_IMAGEGEN_ROOT = os.environ.get("IMAGEGEN_ROOT", "/imagegen")

_SIDECAR_EXTS = (".txt", ".caption")


def _batch_paths(folder: str, name: str):
    """(image, [existing sidecars]) for one entry, resolved on disk."""
    stem = os.path.splitext(name)[0]
    img = os.path.join(folder, name)
    cars = [os.path.join(folder, stem + e) for e in _SIDECAR_EXTS]
    return img, [c for c in cars if os.path.exists(c)]


def _abs_under_imagegen(rel: str) -> str:
    """Resolve a relative imagegen path and REFUSE anything escaping the tree.

    These tools delete files. A traversal here would delete outside the image library, so the
    check is explicit rather than relying on the caller passing something sane.
    """
    base = os.path.realpath(_IMAGEGEN_ROOT)
    full = os.path.realpath(os.path.join(base, _scope(rel).lstrip("/")))
    if full != base and not full.startswith(base + os.sep):
        raise ValueError(f"path escapes the imagegen tree: {rel}")
    return full


@mcp.tool()
def create_training_batch(from_folder: str, images: list[str], batch_folder: str) -> str:
    """Assemble a curated pick into a training batch, copying images + their sidecars.

    COPIES (never moves) each named image from from_folder into batch_folder, along with its
    .txt (booru tags) and .caption (natural language) sidecars, keeping original filenames.

    IDEMPOTENT AND CONVERGENT: re-running makes the batch MATCH `images` exactly — anything in
    the batch that is no longer in the list is removed, so an updated pick converges instead of
    accumulating. Safe to run repeatedly while iterating.

    Returns a manifest: per image, whether it copied, and whether it has the .txt a trainer
    needs. An image WITHOUT .txt would train unlabeled, so it is reported as a warning rather
    than passed over.

    Args:
        from_folder: the curated set, relative (e.g. satin/solids/red/training_set_red).
        images: filenames to include (e.g. ["red-1.png", "red-2.png"]).
        batch_folder: destination, relative (e.g. satin/solids/red/training_batch).
    """
    try:
        src = _abs_under_imagegen(from_folder)
        dst = _abs_under_imagegen(batch_folder)
    except ValueError as e:
        return _j({"error": str(e)})
    if not os.path.isdir(src):
        return _j({"error": f"source folder not found: {from_folder}"})
    os.makedirs(dst, exist_ok=True)

    wanted = [n for n in images if n and not n.startswith(".")]
    manifest, copied, missing_tags, not_found = [], 0, [], []

    for name in wanted:
        img, cars = _batch_paths(src, name)
        if not os.path.exists(img):
            not_found.append(name)
            manifest.append({"file": name, "status": "SOURCE MISSING"})
            continue
        shutil.copy2(img, os.path.join(dst, name))
        exts = []
        for c in cars:
            shutil.copy2(c, os.path.join(dst, os.path.basename(c)))
            exts.append(os.path.splitext(c)[1])
        copied += 1
        has_tags = ".txt" in exts
        if not has_tags:
            missing_tags.append(name)
        manifest.append({"file": name, "status": "copied", "sidecars": exts,
                         "trains_labeled": has_tags})

    # Convergence: drop anything the batch holds that is no longer wanted.
    keep_stems = {os.path.splitext(n)[0] for n in wanted}
    removed = []
    for f in sorted(os.listdir(dst)):
        stem, ext = os.path.splitext(f)
        if ext.lower() in _SIDECAR_EXTS or ext.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
            if stem not in keep_stems:
                try:
                    os.remove(os.path.join(dst, f))
                    removed.append(f)
                except OSError:
                    pass

    out = {
        "batch_folder": _scope(batch_folder),
        "requested": len(wanted), "copied": copied,
        "removed_no_longer_listed": removed,
        "manifest": manifest,
    }
    if not_found:
        out["SOURCE_MISSING"] = not_found
    if missing_tags:
        out["WARNING_UNLABELED"] = {
            "files": missing_tags,
            "note": "these have no .txt sidecar and would train UNLABELED — caption them or "
                    "drop them before training",
        }
    return _j(out)


@mcp.tool()
def remove_from_training_batch(batch_folder: str, images: list[str]) -> str:
    """Remove specific images (and their sidecars) from a training batch.

    For iterating on a pick without rebuilding it. Removing something not present is not an
    error — it is reported as 'absent' so a repeated call is safe.

    Args:
        batch_folder: the batch, relative.
        images: filenames to remove.
    """
    try:
        dst = _abs_under_imagegen(batch_folder)
    except ValueError as e:
        return _j({"error": str(e)})
    if not os.path.isdir(dst):
        return _j({"error": f"batch folder not found: {batch_folder}"})

    results = []
    for name in images:
        img, cars = _batch_paths(dst, name)
        gone = []
        for p in [img] + cars:
            if os.path.exists(p):
                try:
                    os.remove(p)
                    gone.append(os.path.basename(p))
                except OSError as e:
                    return _j({"error": f"could not remove {p}: {e}"})
        results.append({"file": name, "removed": gone} if gone
                       else {"file": name, "status": "absent"})
    remaining = len([f for f in os.listdir(dst)
                     if os.path.splitext(f)[1].lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}])
    return _j({"batch_folder": _scope(batch_folder), "results": results,
               "images_remaining": remaining})


@mcp.tool()
def set_subsection_repeats(batch_folder: str, concept: str, repeats: int) -> str:
    """Change a batch subsection's kohya repeats by renaming <old>_<concept> to <repeats>_<concept>.

    Subsections are kohya's dataset convention: the folder-name prefix IS the per-epoch
    repeat count for that concept's images (e.g. 20_blue). AI Toolkit ignores the names,
    so changing repeats never affects an AI Toolkit run.

    Args:
        batch_folder: the training batch, relative (e.g. _batches/training_batch_satin).
        concept: the subsection's concept name (e.g. blue).
        repeats: new per-epoch repeats, 1-999.
    """
    try:
        dst = _abs_under_imagegen(batch_folder)
    except ValueError as e:
        return _j({"error": str(e)})
    if not os.path.isdir(dst):
        return _j({"error": f"batch folder not found: {batch_folder}"})
    if not isinstance(repeats, int) or not (1 <= repeats <= 999):
        return _j({"error": "repeats must be an integer 1-999"})
    cur = next((d for d in sorted(os.listdir(dst))
                if re.fullmatch(r"\d+_" + re.escape(concept), d)
                and os.path.isdir(os.path.join(dst, d))), None)
    if not cur:
        subs = [d for d in sorted(os.listdir(dst)) if re.fullmatch(r"\d+_.+", d) and os.path.isdir(os.path.join(dst, d))]
        return _j({"error": f"no subsection for concept {concept!r}", "existing_subsections": subs})
    new = f"{repeats}_{concept}"
    if new == cur:
        return _j({"ok": True, "unchanged": True, "folder": cur})
    if os.path.exists(os.path.join(dst, new)):
        return _j({"error": f"{new} already exists in this batch"})
    os.rename(os.path.join(dst, cur), os.path.join(dst, new))
    return _j({"ok": True, "folder": new, "was": cur, "concept": concept, "repeats": repeats})


@mcp.tool()
def list_training_batch(batch_folder: str) -> str:
    """List a training batch's contents and per-image sidecar presence.

    FLAGS any image missing its .txt sidecar — that image would train UNLABELED, which quietly
    degrades the LoRA rather than failing, so it is surfaced as a blocking warning and counted
    separately. Also reports orphan sidecars (a .txt whose image is gone).

    Args:
        batch_folder: the batch, relative.
    """
    try:
        dst = _abs_under_imagegen(batch_folder)
    except ValueError as e:
        return _j({"error": str(e)})
    if not os.path.isdir(dst):
        return _j({"error": f"batch folder not found: {batch_folder}"})

    files = sorted(os.listdir(dst))
    # kohya subsections: <repeats>_<concept> subdirs. Repeats are read straight from the
    # folder name — the name IS the setting (change it with set_subsection_repeats).
    subsections = []
    for d in files:
        m = re.fullmatch(r"(\d+)_(.+)", d)
        if m and os.path.isdir(os.path.join(dst, d)):
            sfiles = sorted(os.listdir(os.path.join(dst, d)))
            simgs = [f for f in sfiles
                     if os.path.splitext(f)[1].lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
                     and not f.startswith("_collage")]
            sstems = {os.path.splitext(f)[0] for f in simgs}
            sunlab = [f for f in simgs if not os.path.exists(os.path.join(dst, d, os.path.splitext(f)[0] + ".txt"))]
            subsections.append({"folder": d, "concept": m.group(2), "repeats": int(m.group(1)),
                                "path": f"{batch_folder.rstrip('/')}/{d}", "images": len(simgs),
                                "unlabeled": sunlab,
                                "note": "unlabeled images train WITHOUT captions" if sunlab else None})
    imgs = [f for f in files
            if os.path.splitext(f)[1].lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
            and not f.startswith("_collage")]
    img_stems = {os.path.splitext(f)[0] for f in imgs}

    rows, unlabeled = [], []
    for f in imgs:
        stem = os.path.splitext(f)[0]
        has_txt = os.path.exists(os.path.join(dst, stem + ".txt"))
        has_cap = os.path.exists(os.path.join(dst, stem + ".caption"))
        if not has_txt:
            unlabeled.append(f)
        try:
            size = os.path.getsize(os.path.join(dst, f))
        except OSError:
            size = None
        rows.append({"file": f, "txt": has_txt, "caption": has_cap, "bytes": size})

    orphans = [f for f in files
               if os.path.splitext(f)[1].lower() in _SIDECAR_EXTS
               and os.path.splitext(f)[0] not in img_stems]

    out = {"batch_folder": _scope(batch_folder), "images": len(imgs), "files": rows,
           "ready_to_train": (not unlabeled and len(imgs) > 0)
                             or (bool(subsections) and not any(s["unlabeled"] for s in subsections)
                                 and any(s["images"] for s in subsections))}
    if subsections:
        out["subsections"] = subsections
        if imgs:
            out["kohya_note"] = ("this batch has SUBSECTIONS: kohya trains ONLY the "
                                 "<repeats>_<concept> subfolders — the %d root-level image(s) "
                                 "would be ignored by kohya (AI Toolkit reads everything). "
                                 "Move them into a subsection or accept the asymmetry." % len(imgs))
    if unlabeled:
        out["BLOCKING_UNLABELED"] = {
            "count": len(unlabeled), "files": unlabeled,
            "note": "no .txt sidecar — these would train UNLABELED. Fix before training.",
        }
    if orphans:
        out["orphan_sidecars"] = orphans
    if not imgs:
        out["note"] = "batch is EMPTY — nothing to train"
    return _j(out)


# ══════════════════════════════════════════════════════════════════════════════
# Tool Set B — LoRA training control (Loom's pipeline, 2026-09-02)
#
# B1 kohya_ss   → SDXL-family bases (Pony_XL, Illustrious, NoobAI)
# B2 AI Toolkit → everything else (flux/chroma/flex/lumina). NOT Krea 2 — see aitoolkit_status.
#
# Runs are DETACHED (setsid) on ai-epyc and tracked in a run directory on the shared mount, so a
# tool call that returns in a second can still be followed for hours.
# ══════════════════════════════════════════════════════════════════════════════

_TRAIN_HOST = os.environ.get("LORA_TRAIN_HOST", "root@10.0.0.234")
_TRAIN_KEY = os.environ.get("LORA_TRAIN_KEY", "/opt/ai-lab/.gybackend-data/ssh/id_ed25519")
_RUNS_ROOT = os.environ.get("LORA_RUNS_ROOT", "/imagegen/lora_runs")
_KOHYA_DIR = "/opt/kohya-ss"
_KOHYA_PY = "/opt/conda/envs/kohya-ss/bin/python"
_KOHYA_ACCEL = "/opt/conda/envs/kohya-ss/bin/accelerate"
_AITK_DIR = "/opt/ai-toolkit"
_AITK_PY = "/opt/conda/envs/ai-toolkit/bin/python"
_CKPT_ROOT = "/imagegen/checkpoints"
_LORA_OUT = "/imagegen/loras"


def _ssh(cmd: str, timeout: int = 60):
    """Run a command on the training host. Returns (rc, stdout, stderr)."""
    p = subprocess.run(
        ["ssh", "-i", _TRAIN_KEY, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
         "-o", "ConnectTimeout=10", _TRAIN_HOST, cmd],
        capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()


def _run_dir(run_id: str) -> str:
    d = os.path.realpath(os.path.join(_RUNS_ROOT, run_id))
    if not d.startswith(os.path.realpath(_RUNS_ROOT) + os.sep):
        raise ValueError(f"bad run_id: {run_id}")
    return d


def _read_run(run_id: str) -> dict:
    with open(os.path.join(_run_dir(run_id), "run.json")) as f:
        return _json.load(f)


def _write_run(run_id: str, meta: dict) -> None:
    with open(os.path.join(_run_dir(run_id), "run.json"), "w") as f:
        _json.dump(meta, f, indent=2)


@mcp.tool()
def kohya_status() -> str:
    """Is kohya_ss installed, where, is a run active, and what GPU capacity is free.

    Also answers the question Loom asked explicitly: kohya_ss does NOT train Krea 2. kohya's
    SDXL trainer targets the SDXL architecture; Krea 2 is a different (diffusion transformer)
    model and needs AI Toolkit — see aitoolkit_status, which reports its own bad news.
    """
    rc, out, err = _ssh(
        f"test -f {_KOHYA_DIR}/sd-scripts/sdxl_train_network.py && echo SCRIPT_OK; "
        f"test -x {_KOHYA_PY} && echo PY_OK; test -x {_KOHYA_ACCEL} && echo ACCEL_OK; "
        f"cd {_KOHYA_DIR} && git log -1 --format='COMMIT %h %ad' --date=short 2>/dev/null; "
        f"nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv,noheader")
    if rc != 0 and not out:
        return _j({"installed": "UNKNOWN", "error": f"cannot reach {_TRAIN_HOST}: {err[:160]}",
                   "note": "cannot-check is not the same as not-installed"})
    gpus = []
    for line in out.splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) == 4 and parts[0].isdigit():
            used, total = int(parts[2].split()[0]), int(parts[3].split()[0])
            gpus.append({"index": int(parts[0]), "name": parts[1],
                         "free_mib": total - used, "total_mib": total})
    active = _active_runs()
    return _j({
        "installed": "SCRIPT_OK" in out and "PY_OK" in out,
        "host": _TRAIN_HOST, "path": _KOHYA_DIR,
        "version": next((l.replace("COMMIT ", "") for l in out.splitlines() if l.startswith("COMMIT")), "unknown"),
        "entry_point": "sd-scripts/sdxl_train_network.py (via accelerate)",
        "trains": ["SDXL-family: Pony_XL, Illustrious, NoobAI"],
        "does_NOT_train": {
            "Krea 2": "different architecture (diffusion transformer, not SDXL). kohya cannot "
                      "train it — route to AI Toolkit, but read aitoolkit_status first.",
        },
        "gpus": gpus,
        "recommended_gpu": max(gpus, key=lambda g: g["free_mib"])["index"] if gpus else None,
        "active_runs": active,
    })


@mcp.tool()
def aitoolkit_status() -> str:
    """Is AI Toolkit installed, what version, and can it actually train Krea 2 today.

    🛑 READ THE VERDICT. Travis's plan routes Krea 2 here because kohya cannot train it. The
    INSTALLED checkout is from 2026-03-28 and its model registry has no Krea entry, so Krea 2
    is not trainable on this box as it stands. That is reported rather than left to fail
    halfway through a run.
    """
    rc, out, err = _ssh(
        f"test -f {_AITK_DIR}/run.py && echo RUN_OK; test -x {_AITK_PY} && echo PY_OK; "
        f"cd {_AITK_DIR} && git log -1 --format='COMMIT %h %ad' --date=short 2>/dev/null; "
        f"ls {_AITK_DIR}/toolkit/models/ 2>/dev/null | tr '\\n' ' '; echo; "
        f"grep -rli krea {_AITK_DIR}/toolkit {_AITK_DIR}/config 2>/dev/null | head -3")
    if rc != 0 and not out:
        return _j({"installed": "UNKNOWN", "error": f"cannot reach {_TRAIN_HOST}: {err[:160]}"})
    krea_hits = [l for l in out.splitlines() if "/krea" in l.lower() or l.lower().endswith("krea.py")]
    version = next((l.replace("COMMIT ", "") for l in out.splitlines() if l.startswith("COMMIT")), "unknown")
    return _j({
        "installed": "RUN_OK" in out and "PY_OK" in out,
        "host": _TRAIN_HOST, "path": _AITK_DIR, "version": version,
        "invocation": f"{_AITK_PY} run.py <config.yaml>  (YAML config, see config/examples/)",
        "krea_2_supported": bool(krea_hits),
        "VERDICT": (
            "Krea 2 is NOT trainable with this install. The checkout is from "
            f"{version} and its model registry contains no Krea architecture "
            "(flux / chroma / flex / lumina / auraflow / cogview4 only). Training would fail at "
            "model load, not at config time. To enable it: update /opt/ai-toolkit and its deps "
            "on ai-epyc, then re-check — that is a deliberate change to a training rig and "
            "should be a decision, not a side effect of a training request."
        ) if not krea_hits else "Krea architecture present — verify against a short run.",
        "usable_today_for": ["flux", "chroma", "flex", "lumina"],
    })


def _active_runs():
    """Runs whose recorded PID is still alive on the training host."""
    try:
        ids = [d for d in os.listdir(_RUNS_ROOT) if os.path.isdir(os.path.join(_RUNS_ROOT, d))]
    except OSError:
        return []
    live = []
    for rid in ids:
        try:
            meta = _read_run(rid)
        except Exception:
            continue
        if meta.get("state") not in ("running",):
            continue
        rc, out, _ = _ssh(f"kill -0 {meta.get('pid')} 2>/dev/null && echo ALIVE", timeout=25)
        if "ALIVE" in out:
            live.append({"run_id": rid, "output_name": meta.get("output_name"),
                         "started": meta.get("started")})
        else:
            meta["state"] = "finished_or_died"
            try:
                _write_run(rid, meta)
            except Exception:
                pass
    return live


@mcp.tool()
def train_lora(batch_folder: str, output_name: str, base_model: str = "",
               trigger: str = "", trainer: str = "kohya", repeats: int = 10,
               resolution: int = 1024, network_dim: int = 16, network_alpha: int = 16,
               learning_rate: str = "1e-4", optimizer: str = "AdamW8bit",
               scheduler: str = "cosine", train_batch_size: int = 2, max_epochs: int = 10,
               save_every_n_epochs: int = 2, gpu_index: int = -1,
               mixed_precision: str = "bf16", attention: str = "sdpa",
               dry_run: bool = False) -> str:
    """Launch a LoRA training run from a training_batch. Returns a run_id immediately.

    VALIDATES BEFORE LAUNCHING, because a run that dies twenty minutes in for a reason visible
    up front wastes an hour: the batch must exist, hold images, and every image must have its
    .txt sidecar (an unlabeled image trains as noise). Refuses rather than warns.

    Builds kohya's expected dataset layout automatically — kohya wants
    <dataset>/<repeats>_<concept>/ containing the images, not a flat folder — using symlinks so
    nothing is duplicated.

    Bucketing is ON (enable_bucket, 1024 base) because the batch mixes cropped 1024x1024 with
    native-resolution portrait/landscape images.

    Args:
        batch_folder: the training batch, relative (e.g. satin/solids/red/training_batch).
        output_name: LoRA name, e.g. satin_string_bikini_panties_v1.
        base_model: absolute path to the base checkpoint. Empty = pick the newest Illustrious.
        trigger: concept/trigger word for the dataset folder. Empty = output_name.
        trainer: 'kohya' (SDXL). 'aitoolkit' is refused until its Krea support exists.
        repeats: dataset repeats per epoch (kohya's N_ prefix).
        gpu_index: -1 picks the GPU with the most free VRAM.
        dry_run: build everything and return the exact command WITHOUT launching.
    """
    if trainer not in ("kohya", "aitoolkit"):
        return _j({"error": f"unknown trainer {trainer!r} — use 'kohya' or 'aitoolkit'"})
    if trainer == "aitoolkit":
        return _j({"error": "AI Toolkit training is not wired up: the installed checkout "
                            "(2026-03-28) has no Krea support, which is the only reason to use "
                            "it here. Call aitoolkit_status() for the detail.",
                   "action": "update /opt/ai-toolkit on ai-epyc first — a deliberate change"})

    # ── validate the dataset BEFORE doing anything expensive ──
    try:
        batch_abs = _abs_under_imagegen(batch_folder)
    except ValueError as e:
        return _j({"error": str(e)})
    if not os.path.isdir(batch_abs):
        return _j({"error": f"batch folder not found: {batch_folder}"})
    _is_img = lambda f: (os.path.splitext(f)[1].lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
                         and not f.startswith("_collage"))
    imgs = [f for f in sorted(os.listdir(batch_abs)) if _is_img(f) and os.path.isfile(os.path.join(batch_abs, f))]
    # Subsectioned batches (<repeats>_<concept> subdirs) usually have NO root-level images —
    # count and label-check inside the subsections too, or a fully organised batch reads as
    # empty and a mislabeled subsection image trains silently uncaptioned.
    sub_imgs = []   # (subdir, filename)
    for d in sorted(os.listdir(batch_abs)):
        dp = os.path.join(batch_abs, d)
        if os.path.isdir(dp) and re.fullmatch(r"\d+_.+", d):
            sub_imgs += [(d, f) for f in sorted(os.listdir(dp)) if _is_img(f) and os.path.isfile(os.path.join(dp, f))]
    if not imgs and not sub_imgs:
        return _j({"error": f"batch is EMPTY: {batch_folder}"})
    unlabeled = [f for f in imgs
                 if not os.path.exists(os.path.join(batch_abs, os.path.splitext(f)[0] + ".txt"))]
    unlabeled += [f"{d}/{f}" for d, f in sub_imgs
                  if not os.path.exists(os.path.join(batch_abs, d, os.path.splitext(f)[0] + ".txt"))]
    if unlabeled:
        return _j({"error": "REFUSING to train: images without a .txt sidecar would train "
                            "UNLABELED and quietly degrade the LoRA",
                   "unlabeled": unlabeled[:20], "count": len(unlabeled),
                   "fix": "caption them (run_tagger) or remove_from_training_batch them"})

    # ── the trigger must be a token the model will ACTUALLY see ──
    # kohya names the concept dir <repeats>_<trigger>, and that name becomes the
    # ss_tag_frequency key in the LoRA metadata. A trigger that is not in the captions
    # therefore publishes a token the model never learned, and whoever reads the metadata
    # to find the trigger prompts the wrong word. That happened once already.
    def _leading_tokens(folder, files):
        lead, seen = {}, 0
        for f in files:
            p = os.path.join(folder, os.path.splitext(f)[0] + ".txt")
            try:
                txt = open(p, encoding="utf-8", errors="replace").read().strip()
            except OSError:
                continue
            if not txt:
                continue
            seen += 1
            first = txt.split(",")[0].strip()
            if first:
                lead[first] = lead.get(first, 0) + 1
        return lead, seen

    _lead, _seen = _leading_tokens(batch_abs, imgs)
    detected, detected_n = (max(_lead.items(), key=lambda kv: kv[1]) if _lead else (None, 0))
    # "dominant" = leads at least 90% of the captions we could read.
    dominant = detected if (_seen and detected_n >= 0.9 * _seen) else None

    trig = (trigger or "").strip().replace(" ", "_")
    if trig:
        # Accept it only if it genuinely appears in the captions.
        present = sum(1 for f in imgs
                      if trig in open(os.path.join(batch_abs, os.path.splitext(f)[0] + ".txt"),
                                      encoding="utf-8", errors="replace").read())
        if present < 0.9 * len(imgs):
            return _j({"error": "REFUSING to train: the trigger is not in the captions, so the "
                                "LoRA would be published under a token the model never sees",
                       "trigger_given": trig,
                       "captions_containing_it": present,
                       "captions_total": len(imgs),
                       "trigger_detected_in_captions": dominant,
                       "detected_leads_n_captions": detected_n,
                       "fix": (f"pass trigger='{dominant}' (what the captions actually lead with), "
                               "or omit trigger to use it automatically, or re-caption with the "
                               "trigger you want")})
    else:
        trig = dominant or output_name.strip().replace(" ", "_")

    if not base_model:
        rc, out, _ = _ssh(f"ls -t {_CKPT_ROOT}/Illustrious/*.safetensors 2>/dev/null | head -1")
        base_model = out.strip()
        if not base_model:
            return _j({"error": "no base_model given and no Illustrious checkpoint found",
                       "hint": f"pass base_model, e.g. {_CKPT_ROOT}/Pony_XL/PonyMegaMixXL_v20.safetensors"})
    rc, out, _ = _ssh(f"test -f '{base_model}' && echo OK")
    if "OK" not in out:
        return _j({"error": f"base_model not found on {_TRAIN_HOST}: {base_model}"})

    if gpu_index < 0:
        rc, out, _ = _ssh("nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader")
        best, best_free = 0, -1
        for line in out.splitlines():
            p = [x.strip() for x in line.split(",")]
            if len(p) == 3 and p[0].isdigit():
                free = int(p[2].split()[0]) - int(p[1].split()[0])
                if free > best_free:
                    best, best_free = int(p[0]), free
        gpu_index = best
        if best_free < 10000:
            return _j({"error": f"no GPU has enough free VRAM (best: GPU{best} with {best_free} MiB)",
                       "note": "SDXL LoRA at 1024 needs roughly 10-12 GiB free; wait or free a GPU"})

    run_id = f"{output_name}-{_time.strftime('%Y%m%d-%H%M%S')}"
    rdir = os.path.join(_RUNS_ROOT, run_id)
    dsdir = os.path.join(rdir, "dataset", f"{repeats}_{trig}")
    os.makedirs(dsdir, exist_ok=True)
    # 🛑 COPY, NOT SYMLINK. The training host cannot see symlinks written here: /imagegen is
    # shared, but a symlink created on CT152 is invisible on ai-epyc (verified with a plain-file
    # control, which IS visible), and hardlinks fail with "Invalid cross-device link" because
    # lora_runs and training_images are separate devices. The first real run died with kohya's
    # "No data found" against a directory that looked full from here and was empty from there.
    # An earlier `except OSError: copy` fallback could never fire, because the symlink SUCCEEDS
    # locally — it just does not propagate. A fallback keyed on the wrong failure is not one.
    # SUBSECTION-AWARE (2026-09-02): a batch holding kohya <repeats>_<concept> subdirs is
    # already the dataset layout — copy each subsection through AS ITS OWN concept dir
    # (per-section repeats preserved) instead of flattening everything into one folder.
    # Loose root-level files still go into the default <repeats>_<trigger> dir either way.
    total_copied = 0
    for f in os.listdir(batch_abs):
        srcp = os.path.join(batch_abs, f)
        if os.path.isdir(srcp) and re.fullmatch(r"\d+_.+", f):
            sub_dst = os.path.join(rdir, "dataset", f)
            os.makedirs(sub_dst, exist_ok=True)
            for g in os.listdir(srcp):
                if os.path.isfile(os.path.join(srcp, g)) and not os.path.exists(os.path.join(sub_dst, g)):
                    shutil.copy2(os.path.join(srcp, g), os.path.join(sub_dst, g))
                    total_copied += 1
            continue
        if os.path.isfile(srcp):
            dst = os.path.join(dsdir, f)
            if not os.path.exists(dst):
                shutil.copy2(srcp, dst)
                total_copied += 1

    # Confirm the TRAINING HOST can see the dataset. The run that motivated this died because
    # the directory was full locally and empty remotely; one check turns a 40-second failure
    # deep inside kohya into an immediate, explicit error.
    dataset_root = os.path.join(rdir, "dataset")
    rc, seen, _ = _ssh(f"find '{dataset_root}' -type f 2>/dev/null | wc -l", timeout=40)
    try:
        seen_n = int((seen or "0").strip().split()[-1])
    except (ValueError, IndexError):
        seen_n = -1
    if seen_n < len(imgs) + len(sub_imgs):
        return _j({"error": "the training host cannot see the prepared dataset",
                   "detail": f"{_TRAIN_HOST} sees {seen_n} files under {dataset_root}; expected at "
                             f"least {len(imgs) + len(sub_imgs)} images. The run would fail with "
                             "kohya's 'No data found'.",
                   "hint": "check that /imagegen is mounted on the training host and that the "
                           "dataset was copied rather than linked"})

    # Attention backend. DEFAULT sdpa: xformers 0.0.30 here dispatches to a flash-attention
    # HOPPER kernel and dies with "no kernel image is available for execution on the device" on
    # both card types in this box (Ada sm_89, Blackwell sm_120). torch 2.7's native SDPA needs
    # no per-architecture kernel image.
    if attention not in ("sdpa", "xformers", "mem_eff_attn"):
        return _j({"error": f"attention must be sdpa, xformers or mem_eff_attn (got {attention!r})"})
    attn = attention

    outdir = os.path.join(_LORA_OUT, "trained")
    log = os.path.join(rdir, "train.log")
    cmd = (
        # CUDA_DEVICE_ORDER=PCI_BUS_ID: without it CUDA numbers devices by its own
        # heuristic, which does NOT match nvidia-smi — the index we measured free VRAM
        # on could select a different physical card. Verified they agree with it set.
        f"cd {_KOHYA_DIR}/sd-scripts && CUDA_DEVICE_ORDER=PCI_BUS_ID "
        f"CUDA_VISIBLE_DEVICES={gpu_index} "
        f"{_KOHYA_ACCEL} launch --num_cpu_threads_per_process 4 sdxl_train_network.py "
        f"--pretrained_model_name_or_path='{base_model}' "
        f"--train_data_dir='{os.path.join(rdir, 'dataset')}' "
        f"--output_dir='{outdir}' --output_name='{output_name}' "
        # ss_training_comment: an explicit trigger record. ss_tag_frequency's key is a
        # directory name and is easy to misread as the trigger; this is unambiguous.
        f"--training_comment='trigger: {trig}' "
        f"--caption_extension='.txt' --resolution={resolution},{resolution} "
        f"--enable_bucket --min_bucket_reso=512 --max_bucket_reso=2048 --bucket_reso_steps=64 "
        f"--network_module=networks.lora --network_dim={network_dim} --network_alpha={network_alpha} "
        f"--learning_rate={learning_rate} --optimizer_type={optimizer} --lr_scheduler={scheduler} "
        f"--train_batch_size={train_batch_size} --max_train_epochs={max_epochs} "
        f"--save_every_n_epochs={save_every_n_epochs} --save_model_as=safetensors "
        f"--mixed_precision={mixed_precision} --cache_latents --{attn} --gradient_checkpointing "
        f"--seed=42 --logging_dir='{os.path.join(rdir, 'logs')}'"
    )
    meta = {
        "run_id": run_id, "trainer": "kohya", "state": "dry_run" if dry_run else "running",
        "output_name": output_name, "base_model": base_model, "trigger": trig,
        "batch_folder": _scope(batch_folder), "images": len(imgs), "repeats": repeats,
        "gpu_index": gpu_index, "resolution": resolution, "epochs": max_epochs,
        "network_dim": network_dim, "network_alpha": network_alpha,
        "output_dir": outdir, "log": log, "command": cmd,
        "started": _time.strftime("%Y-%m-%d %H:%M:%S"), "pid": None,
    }
    if dry_run:
        _write_run(run_id, meta)
        return _j({**meta, "note": "DRY RUN — nothing launched. Inspect 'command', then re-call "
                                   "with dry_run=false."})

    _ssh(f"mkdir -p '{outdir}' '{os.path.join(rdir, 'logs')}'")

    # 🛑 PERSIST BEFORE LAUNCHING. Metadata must exist the moment the run could exist. Writing it
    # only after a successful launch means any reporting failure leaves an untrackable process
    # holding a GPU, which is the worst outcome available — and it happened: an ssh launch that
    # hung past its timeout raised, so a happily-training run had no run.json and
    # train_lora_status could not find it.
    meta["state"] = "launching"
    _write_run(run_id, meta)

    # setsid: a training run outlives this call by hours. The PID goes to a FILE on the shared
    # mount rather than back over stdout, and the outer shell is redirected too, so ssh has
    # nothing left to wait on — the backgrounded trainer inherits fds and would otherwise hold
    # the channel open until the timeout, turning a successful launch into an exception.
    pidfile = os.path.join(rdir, "pid")
    launch = (f"cd {_KOHYA_DIR}/sd-scripts && "
              f"{{ setsid nohup bash -c {shlex.quote(cmd)} > '{log}' 2>&1 < /dev/null & "
              f"echo $! > '{pidfile}'; }} > /dev/null 2>&1 < /dev/null; exit 0")
    try:
        _ssh(launch, timeout=45)
    except Exception as e:                      # a slow channel must not fail a live launch
        meta["launch_note"] = f"ssh returned {e.__class__.__name__}; checking for the pid file"

    # The pid file is the authority: if it exists, the launch happened, whatever ssh did.
    pid = None
    for _ in range(15):
        try:
            with open(pidfile) as f:
                txt = f.read().strip()
            if txt.isdigit():
                pid = int(txt)
                break
        except OSError:
            pass
        _time.sleep(1)

    if pid is None:
        meta["state"] = "launch_failed"
        meta["error"] = "no pid file appeared; the trainer did not start"
        _write_run(run_id, meta)
        return _j({"error": "launch failed", "run_id": run_id,
                   "detail": "no pid file appeared on the training host", "log": log})
    meta["pid"] = pid
    meta["state"] = "running"
    _write_run(run_id, meta)
    return _j({"run_id": run_id, "state": "running", "pid": int(pid), "gpu_index": gpu_index,
               "images": len(imgs), "base_model": base_model, "output_name": output_name,
               "poll_with": f"train_lora_status('{run_id}')",
               "note": f"{len(imgs)} images x{repeats} repeats over {max_epochs} epochs on GPU{gpu_index}"})


@mcp.tool()
def train_lora_status(run_id: str) -> str:
    """Progress for a run: alive/finished, current epoch/step, recent loss, last checkpoint.

    Pollable. Reads the training log rather than guessing from elapsed time — a run that has
    silently stopped writing is reported as such, not as 'probably still going'.

    Args:
        run_id: from train_lora.
    """
    try:
        meta = _read_run(run_id)
    except Exception as e:
        return _j({"error": f"no such run: {run_id} ({e.__class__.__name__})"})
    alive = False
    if meta.get("pid"):
        rc, out, _ = _ssh(f"kill -0 {meta['pid']} 2>/dev/null && echo ALIVE", timeout=25)
        alive = "ALIVE" in out
    log = meta.get("log", "")
    tail, mtime_age = "", None
    try:
        with open(log, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 6000))
            tail = f.read().decode("utf-8", "replace")
        mtime_age = int(_time.time() - os.path.getmtime(log))
    except OSError:
        pass
    import re as _re
    steps = _re.findall(r"(\d+)/(\d+)\s*\[", tail)
    loss = _re.findall(r"loss[=:]\s*([0-9.]+)", tail, _re.I)
    epoch = _re.findall(r"epoch\s+(\d+)\s*/\s*(\d+)", tail, _re.I)
    # No head -N here: a truncated list under a plain "checkpoints" key is a subset presented as
    # the whole, and a caller counting it silently gets the wrong number.
    rc, ck, _ = _ssh(f"ls -t '{meta.get('output_dir','')}/{meta.get('output_name','')}'*.safetensors 2>/dev/null")
    if not alive and meta.get("state") == "running":
        meta["state"] = "finished" if ck.strip() else "stopped_without_output"
        _write_run(run_id, meta)
    return _j({
        "run_id": run_id, "state": meta.get("state"), "alive": alive,
        "output_name": meta.get("output_name"), "gpu_index": meta.get("gpu_index"),
        "started": meta.get("started"),
        "progress": {"last_step": steps[-1] if steps else None,
                     "epoch": epoch[-1] if epoch else None,
                     "recent_loss": loss[-1] if loss else None},
        "log_idle_seconds": mtime_age,
        "log_stalled": (mtime_age is not None and mtime_age > 600 and alive),
        "checkpoints": [c for c in ck.splitlines() if c.strip()],
        "checkpoint_count": len([c for c in ck.splitlines() if c.strip()]),
        "latest_checkpoint": next((c for c in ck.splitlines() if c.strip()), None),
        "log_tail": tail[-1200:],
    })


@mcp.tool()
def train_lora_stop(run_id: str) -> str:
    """Stop a running training job cleanly (SIGTERM, then SIGKILL if it ignores it).

    Args:
        run_id: from train_lora.
    """
    try:
        meta = _read_run(run_id)
    except Exception as e:
        return _j({"error": f"no such run: {run_id} ({e.__class__.__name__})"})
    pid = meta.get("pid")
    if not pid:
        return _j({"error": "run has no recorded pid", "state": meta.get("state")})
    # Kill the PROCESS GROUP: accelerate spawns children, and killing only the parent leaves the
    # trainer holding the GPU. setsid at launch is what makes the group addressable.
    _ssh(f"kill -TERM -{pid} 2>/dev/null || kill -TERM {pid} 2>/dev/null; true", timeout=25)
    _ssh("sleep 5; true", timeout=25)
    rc, out, _ = _ssh(f"kill -0 {pid} 2>/dev/null && echo STILL", timeout=25)
    if "STILL" in out:
        _ssh(f"kill -KILL -{pid} 2>/dev/null || kill -KILL {pid} 2>/dev/null; true", timeout=25)
    meta["state"] = "stopped"
    _write_run(run_id, meta)
    return _j({"run_id": run_id, "state": "stopped", "pid": pid})


import re

# ── Finalization: an ACCEPTED LoRA enters the library under Travis's v5 naming spec ──
# Spec source of truth: /imagegen/_custodian-spec/naming-conventions.md (LOCKED v5).
# Self-trained LoRAs have no Civitai versionId, so the name is 4 slots:
#   <SubType-or-PrimaryLongName>-<PRI_ABB>-<Title>-<Version>.safetensors
# e.g.  Panties-CON-Red_Satin_String_Bikini_Panties-V1.0.safetensors
# The preview image shares the basename (that is how SDNext/Comfy pickers find it).

# Closed primary-tag table (spec v5). Keys are long names, values the ALL-CAPS abbreviation.
_LORA_PRI_TAGS = {
    "Action": "ACT", "Animal": "ANIM", "Assets": "ASST", "Background": "BG",
    "Base_Model": "BASE", "Buildings": "BD", "Celebrity": "CELEB", "Character": "CHAR",
    "Clothing": "CLOTH", "Concept": "CON", "Objects": "OBJ", "Poses": "POSE",
    "Style": "STYLE", "Tool": "TOOL", "Vehicle": "VH",
}
# CLOSED sub-type whitelist (spec rule 9: NEVER invent new sub-types).
_LORA_SUB_TYPES = {
    "Artist_Style", "Ass", "Body_Style", "BDSM", "Buttplug", "Chastity",
    "Detailer", "Futanari", "Panties", "Penis", "Tits",
}


def _st_header(path):
    """Read a safetensors header without loading tensors. Returns (header, data_start)."""
    with open(path, "rb") as f:
        n = _struct.unpack("<Q", f.read(8))[0]
        return _json.loads(f.read(n)), 8 + n


def _st_data_digest(path, data_start):
    """sha256 of the tensor region only — proves a header rewrite did not touch the weights."""
    h = _hashlib.sha256()
    with open(path, "rb") as f:
        f.seek(data_start)
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _derive_trigger(path):
    """Recover the trigger a weight actually learned, from its own metadata.

    ss_tag_frequency's KEY is the kohya concept DIRECTORY name (<repeats>_<whatever string the
    launcher was handed>) and is NOT the trigger — that is exactly what misled a reviewer once.
    The evidence is the highest-count TAG that appears on essentially every image.
    """
    try:
        hdr, _ = _st_header(path)
    except Exception:
        return None, "unreadable header"
    md = hdr.get("__metadata__") or {}
    m = re.search(r"trigger:\s*(\S+)", str(md.get("ss_training_comment", "")))
    if m:
        return m.group(1), "ss_training_comment"
    if md.get("ss_trigger"):
        return str(md["ss_trigger"]), "ss_trigger"
    tf = md.get("ss_tag_frequency")
    if tf:
        try:
            counts = {}
            for _concept, tags in _json.loads(tf).items():
                for t, c in tags.items():
                    counts[t] = counts.get(t, 0) + c
            if counts:
                top, n = max(counts.items(), key=lambda kv: kv[1])
                if n >= 0.9 * max(counts.values()):
                    return top, "ss_tag_frequency (top tag, %d occurrences)" % n
        except Exception:
            pass
    return None, "no trigger recorded in this weight"


def _stamp_trigger(path, trigger):
    """Record the trigger in the weight's own metadata. Never edits in place.

    Writes a new file, verifies the tensor region is byte-identical by digest and that the tensor
    set is unchanged, and only then atomically replaces. A failure here must never cost the weight.
    """
    hdr, data_start = _st_header(path)
    before_keys = sorted(k for k in hdr if k != "__metadata__")
    before_digest = _st_data_digest(path, data_start)

    md = dict(hdr.get("__metadata__") or {})
    md["ss_training_comment"] = "trigger: %s" % trigger
    md["ss_trigger"] = trigger
    new_hdr = {k: v for k, v in hdr.items() if k != "__metadata__"}
    new_hdr["__metadata__"] = md
    blob = _json.dumps(new_hdr, separators=(",", ":")).encode("utf-8")

    tmp = path + ".stamping"
    try:
        with open(path, "rb") as fi, open(tmp, "wb") as fo:
            fo.write(_struct.pack("<Q", len(blob)))
            fo.write(blob)
            fi.seek(data_start)
            shutil.copyfileobj(fi, fo, 1 << 20)
        vh, vstart = _st_header(tmp)
        if sorted(k for k in vh if k != "__metadata__") != before_keys:
            raise ValueError("tensor set changed")
        if _st_data_digest(tmp, vstart) != before_digest:
            raise ValueError("tensor bytes changed")
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return before_digest


def _abs_imagegen_wide(rel: str) -> str:
    """Whole-tree resolver with the same traversal guard as _abs_under_imagegen.

    _abs_under_imagegen routes through _scope, which deliberately confines the curation
    tools to training_images/ — but finalization spans the tree (loras/, outputs/).
    Accepts bare, imagegen/-prefixed and /imagegen/-prefixed forms.
    """
    q = str(rel or "").strip().lstrip("/")
    if q.startswith("imagegen/"):
        q = q[len("imagegen/"):]
    base = os.path.realpath(_IMAGEGEN_ROOT)
    full = os.path.realpath(os.path.join(base, q))
    if full != base and not full.startswith(base + os.sep):
        raise ValueError(f"path escapes the imagegen tree: {rel}")
    return full


def _lora_slotify(s: str) -> str:
    """Spec slot text: runs of space/junk -> single _, first letter of each word capitalized."""
    words = [w for w in re.split(r"[\s_]+", str(s).strip()) if w]
    words = [(w[0].upper() + w[1:]) if w else w for w in words]
    out = "_".join(words)
    return re.sub(r"[^A-Za-z0-9._-]", "", out)


def _lora_norm_version(v: str) -> str:
    """Spec: capital V with decimal — v1 -> V1.0, V1 -> V1.0, V1.2 unchanged. '' omits the slot."""
    v = str(v).strip()
    if not v:
        return ""
    m = re.fullmatch(r"[vV](\d+)(?:\.(\d+))?", v)
    if not m:
        raise ValueError(f"version must look like V1 / v2 / V1.2 (got {v!r})")
    return f"V{int(m.group(1))}.{m.group(2) or '0'}"


def _lora_families() -> list[str]:
    root = os.path.join(_IMAGEGEN_ROOT, "loras")
    skip = {"trained", "recipes", "OLD"}
    try:
        return sorted(d for d in os.listdir(root)
                      if os.path.isdir(os.path.join(root, d)) and d not in skip)
    except OSError:
        return []


def _lora_audit(entry: dict) -> None:
    """Same JSONL audit stream Custodian writes — one durable line per library mutation."""
    try:
        log_dir = os.path.join(_IMAGEGEN_ROOT, "_organizer-log")
        os.makedirs(log_dir, exist_ok=True)
        entry = {"ts": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()), **entry}
        with open(os.path.join(log_dir, _time.strftime("%Y-%m-%d") + ".jsonl"), "a") as f:
            f.write(_json.dumps(entry) + "\n")
    except OSError:
        pass  # the move itself must not fail because the audit line could not be written


@mcp.tool()
def finalize_lora(source: str, family: str, primary_tag: str, title: str,
                  sub_type: str = "", version: str = "V1.0", preview_image: str = "",
                  trigger: str = "", base_model: str = "", notes: str = "") -> str:
    """Accept a trained LoRA as COMPLETE: apply Travis's naming convention and move it into the library.

    Call this only after the LoRA has been reviewed and accepted (test generation looked
    good). It renames per the v5 spec (/imagegen/_custodian-spec/naming-conventions.md)
    and moves the weight from the training area into /imagegen/loras/<family>/.

    Name = <sub_type or primary long-name>-<PRI_ABB>-<Title>-<Version>.safetensors
    (self-trained LoRAs have no Civitai versionId, so there is no 5th slot).
    Example: sub_type=Panties, primary_tag=Concept, title="Red Satin String Bikini Panties"
    -> Panties-CON-Red_Satin_String_Bikini_Panties-V1.0.safetensors

    NEVER overwrites an existing library file. Writes a provenance .json sidecar and an
    audit line to /imagegen/_organizer-log/. Pass preview_image now, or add it later with
    set_lora_preview once a test image exists.

    Args:
        source: output name from training (finds /imagegen/loras/trained/<name>/<name>.safetensors
            or trained/<name>.safetensors), OR an explicit /imagegen-relative path to the exact
            .safetensors to promote (useful when an intermediate checkpoint is the accepted one).
        family: target family folder under /imagegen/loras/ — must already exist (e.g. Pony_XL,
            Illustrious, Krea_2). Case-exact; the error lists valid families.
        primary_tag: the model layer this LoRA touches, from the CLOSED table: Action, Animal,
            Assets, Background, Base_Model, Buildings, Celebrity, Character, Clothing, Concept,
            Objects, Poses, Style, Tool, Vehicle. (Abbreviations like CON also accepted.)
        title: human title; spaces become underscores, words capitalized.
        sub_type: optional, from the CLOSED whitelist (Artist_Style, Ass, Body_Style, BDSM,
            Buttplug, Chastity, Detailer, Futanari, Panties, Penis, Tits). Leave empty to use
            the primary tag's long name in slot 1. Never invent new sub-types.
        version: V1 / V1.2 style; normalized to V#.# per spec. Empty string omits the slot.
        preview_image: optional /imagegen-relative path to the accepted test image; installed
            beside the weight with the matching basename.
        trigger: the token the training captions actually lead with. Stamped into the
            weight's own metadata (ss_trigger + ss_training_comment) as well as the
            provenance sidecar, so a generating agent can recover it from the file.
            If omitted it is derived from the weight's existing metadata; kohya weights
            usually carry it, AI Toolkit weights record NO trigger and always need it
            passed. Finalize REFUSES when none can be determined -- a LoRA in the library
            that nobody can prompt is the defect this guards.
        base_model: base checkpoint the LoRA was trained on (recorded in provenance).
        notes: free text for provenance.
    """
    # ---- resolve the source weight ----
    try:
        if "/" in source:
            src = _abs_imagegen_wide(source)
        else:
            cands = [os.path.join(_IMAGEGEN_ROOT, "loras", "trained", source, f"{source}.safetensors"),
                     os.path.join(_IMAGEGEN_ROOT, "loras", "trained", f"{source}.safetensors")]
            src = next((c for c in cands if os.path.isfile(c)), "")
            if not src:
                return _j({"error": f"no trained weight found for {source!r}",
                           "looked_at": [os.path.relpath(c, _IMAGEGEN_ROOT) for c in cands],
                           "hint": "pass an explicit path if the accepted file is an intermediate checkpoint"})
    except ValueError as e:
        return _j({"error": str(e)})
    if not os.path.isfile(src) or not src.endswith(".safetensors"):
        return _j({"error": f"source is not a .safetensors file: {source}"})

    # ---- validate the closed vocabularies (spec rules 1-3, 9) ----
    fams = _lora_families()
    if family not in fams:
        return _j({"error": f"family {family!r} is not a library folder", "valid_families": fams,
                   "note": "family folders are created by Travis, not by this tool"})
    pt = str(primary_tag).strip().replace(" ", "_")
    long_name = next((k for k in _LORA_PRI_TAGS
                      if k.lower() == pt.lower() or _LORA_PRI_TAGS[k] == pt.upper()), "")
    if not long_name:
        return _j({"error": f"primary_tag {primary_tag!r} is not in the closed table",
                   "valid": _LORA_PRI_TAGS})
    st = ""
    if str(sub_type).strip():
        st = next((s for s in _LORA_SUB_TYPES
                   if s.lower() == str(sub_type).strip().replace(" ", "_").lower()), "")
        if not st:
            return _j({"error": f"sub_type {sub_type!r} is not in the CLOSED whitelist — never invent sub-types",
                       "valid": sorted(_LORA_SUB_TYPES),
                       "fallback": "omit sub_type to use the primary tag's long name in slot 1"})
    try:
        ver = _lora_norm_version(version)
    except ValueError as e:
        return _j({"error": str(e)})
    t = _lora_slotify(title)
    if not t:
        return _j({"error": "title is empty after normalization"})

    name = f"{st or long_name}-{_LORA_PRI_TAGS[long_name]}-{t}" + (f"-{ver}" if ver else "")
    dest_dir = os.path.join(_IMAGEGEN_ROOT, "loras", family)
    dest = os.path.join(dest_dir, f"{name}.safetensors")
    if os.path.exists(dest):
        return _j({"error": f"destination already exists: {os.path.relpath(dest, _IMAGEGEN_ROOT)}",
                   "note": "never overwrites — bump the version, or ask Travis"})

    # ---- optional preview, validated BEFORE the move so a bad path aborts cleanly ----
    prev_src = ""
    if str(preview_image).strip():
        try:
            prev_src = _abs_imagegen_wide(preview_image)
        except ValueError as e:
            return _j({"error": f"preview_image: {e}"})
        if not os.path.isfile(prev_src):
            return _j({"error": f"preview_image not found: {preview_image}"})

    # ---- the trigger must be KNOWN before this weight enters the library ----
    # Checked before the move so a refusal leaves everything where it was. A LoRA in the library
    # whose trigger nobody can recover is the defect that made a reviewer pass a LoRA that was
    # never firing: they read the published label and prompted it.
    trig = (trigger or "").strip()
    trig_from = "caller"
    if not trig:
        trig, trig_from = _derive_trigger(src)
    if not trig:
        return _j({"error": "REFUSING to finalize: no trigger given and none recoverable from the "
                            "weight, so this LoRA would enter the library unprompteable",
                   "source": os.path.relpath(src, _IMAGEGEN_ROOT),
                   "why": trig_from,
                   "fix": "pass trigger='<the token the captions actually lead with>'. AI Toolkit "
                          "records no trigger at all, so its weights ALWAYS need it passed "
                          "explicitly; the output name is NOT the trigger."})

    # ---- move (same mount -> atomic rename), provenance, audit ----
    size = os.path.getsize(src)
    shutil.move(src, dest)
    if os.path.getsize(dest) != size:
        return _j({"error": "size mismatch after move — INVESTIGATE before using this file",
                   "dest": os.path.relpath(dest, _IMAGEGEN_ROOT)})
    # Stamp the trigger into the weight itself. A sidecar only helps someone who opens it;
    # the metadata is what a generating agent reads. Failure here must not cost the weight,
    # which is already safely moved — so it degrades to a loud flag, not an error.
    stamp_note = None
    try:
        _stamp_trigger(dest, trig)
        stamp_note = "ss_training_comment + ss_trigger = %r (source: %s)" % (trig, trig_from)
    except Exception as e:
        stamp_note = "STAMP FAILED (%s: %s) — weight is intact but carries NO trigger metadata; " \
                     "record it manually before anyone generates with it" % (type(e).__name__, e)

    result = {"ok": True, "name": name,
              "lora": os.path.relpath(dest, _IMAGEGEN_ROOT),
              "slots": {"slot1": st or long_name, "slot2": _LORA_PRI_TAGS[long_name],
                        "slot3": t, "slot4": ver or "(omitted)"},
              "trigger": trig, "trigger_source": trig_from, "trigger_stamped": stamp_note}
    if prev_src:
        prev_ext = os.path.splitext(prev_src)[1].lower() or ".png"
        prev_dest = os.path.join(dest_dir, f"{name}{prev_ext}")
        shutil.copy2(prev_src, prev_dest)
        result["preview"] = os.path.relpath(prev_dest, _IMAGEGEN_ROOT)
    else:
        result["preview"] = None
        result["next_step"] = "generate a test image and install it with set_lora_preview — a LoRA without a preview is a blank square in every picker"
    sidecar = {"finalized": _time.strftime("%Y-%m-%d %H:%M:%S"),
               "source": os.path.relpath(src, _IMAGEGEN_ROOT), "trigger": trig,
               "trigger_source": trig_from,
               "base_model": base_model, "family": family, "notes": notes,
               "trained_locally": True}
    try:
        with open(os.path.join(dest_dir, f"{name}.json"), "w") as f:
            _json.dump(sidecar, f, indent=2)
        result["sidecar"] = os.path.relpath(os.path.join(dest_dir, f"{name}.json"), _IMAGEGEN_ROOT)
    except OSError as e:
        result["sidecar_error"] = str(e)
    _lora_audit({"op": "finalize_lora", "src": os.path.relpath(src, _IMAGEGEN_ROOT),
                 "dest": os.path.relpath(dest, _IMAGEGEN_ROOT), "trigger": trigger, "by": "mcp"})
    return _j(result)


@mcp.tool()
def set_lora_preview(lora_path: str, image_path: str, replace: bool = False) -> str:
    """Install (or replace) the preview image for a library LoRA.

    Copies the image beside the weight with the SAME basename — that filename match is
    what makes it show up as the LoRA's preview in the pickers. Name the test generation
    after the LoRA by calling this; no manual renaming needed.

    Args:
        lora_path: /imagegen-relative path to the .safetensors in the library
            (e.g. loras/Pony_XL/Panties-CON-Red_Satin_String_Bikini_Panties-V1.0.safetensors).
        image_path: /imagegen-relative path to the image (a ComfyUI output is fine).
        replace: must be True to overwrite an existing preview.
    """
    try:
        lora = _abs_imagegen_wide(lora_path)
        img = _abs_imagegen_wide(image_path)
    except ValueError as e:
        return _j({"error": str(e)})
    if not os.path.isfile(lora) or not lora.endswith(".safetensors"):
        return _j({"error": f"not a library .safetensors: {lora_path}"})
    if not os.path.isfile(img):
        return _j({"error": f"image not found: {image_path}"})
    base = os.path.splitext(lora)[0]
    ext = os.path.splitext(img)[1].lower() or ".png"
    dest = base + ext
    existing = [base + e for e in (".png", ".jpg", ".jpeg", ".webp") if os.path.exists(base + e)]
    if existing and not replace:
        return _j({"error": "a preview already exists — pass replace=true to swap it",
                   "existing": [os.path.relpath(e, _IMAGEGEN_ROOT) for e in existing]})
    for e in existing:
        if e != dest:
            os.remove(e)   # one preview, one basename — two different-ext previews confuse pickers
    shutil.copy2(img, dest)
    _lora_audit({"op": "set_lora_preview", "lora": os.path.relpath(lora, _IMAGEGEN_ROOT),
                 "image": os.path.relpath(img, _IMAGEGEN_ROOT),
                 "dest": os.path.relpath(dest, _IMAGEGEN_ROOT), "replaced": bool(existing), "by": "mcp"})
    return _j({"ok": True, "preview": os.path.relpath(dest, _IMAGEGEN_ROOT),
               "replaced": [os.path.relpath(e, _IMAGEGEN_ROOT) for e in existing]})


@mcp.tool()
def list_lora_outputs() -> str:
    """List trained LoRA .safetensors with size and mtime, newest first, plus known runs."""
    rc, out, _ = _ssh(
        f"ls -lt --time-style=+%Y-%m-%d_%H:%M '{_LORA_OUT}/trained/'*.safetensors 2>/dev/null | head -25")
    files = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 7:
            files.append({"file": parts[-1], "bytes": int(parts[4]) if parts[4].isdigit() else None,
                          "modified": parts[5]})
    runs = []
    try:
        for rid in sorted(os.listdir(_RUNS_ROOT), reverse=True)[:15]:
            try:
                m = _read_run(rid)
                runs.append({"run_id": rid, "state": m.get("state"),
                             "output_name": m.get("output_name"), "started": m.get("started")})
            except Exception:
                continue
    except OSError:
        pass
    return _j({"output_dir": f"{_LORA_OUT}/trained", "loras": files, "runs": runs})


# ══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT — MUST STAY LAST IN THIS FILE.
#
# mcp.run() blocks. Anything defined BELOW it never executes when the module is run as a
# server, so a tool appended after this line is silently absent from tools/list while still
# importable and still passing any test that imports the module. That exact mistake cost a
# debugging round on 2026-09-02: the file held 31 tools and the server advertised 22.
#
# Append new tools ABOVE this block.
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    mcp.run(transport="stdio")
