"""Media library for the Fansly/Coomer/Kemono addon: the native Browser tab's backend.

The scrapers keep no per-file database we can rely on, so the library IS the download folders:
<service root>/<creator>/<section...>/<file>. A scan is cached for SCAN_TTL seconds; a file is
addressed by "<service>:<path relative to the service root>" everywhere (selection, delete,
training sets), so nothing here can drift out of step with the disk.

Training sets follow the rule34/social model: copies land in TRAINING_IMAGES_ROOT/<set>/ as
<prefix>_<stem>.<ext>, recorded in a per-set ledger, and membership = ledger + filename scan.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse, Response

log = logging.getLogger("fansly.library")

TRAINING_IMAGES_ROOT = os.environ.get("TRAINING_IMAGES_ROOT", "/imagegen/training_images")
BATCHES_ROOT = os.environ.get("TRAINING_BATCHES_ROOT", "/imagegen/_batches")
THUMB_DIR = Path(__file__).resolve().parent / "data" / "thumbs"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"}
# training-set filename prefix per service (and the membership key prefix)
PREFIX = {"fansly": "fans", "coomer": "coomer", "kemono": "kemono", "coomerfans": "cfans"}
LEDGER = ".fansly-members.json"
MEMBER_RE = re.compile(r"^(fans|coomer|kemono|cfans)_(.+)\.[A-Za-z0-9]+$")
# fansly-scraper names files "2024-01-19_at_00-49_UTC_id_604529211478122496.jpeg"
POSTED_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})_at_(\d{2})-(\d{2})_UTC")
SCAN_TTL = 30.0

router = APIRouter(prefix="/lib")
ROOTS: dict[str, Path] = {}
LABELS: dict[str, str] = {}

_scan_lock = threading.Lock()
_scan: dict[str, Any] = {"at": 0.0, "items": []}
_dims: dict[str, tuple[int, int] | None] = {}


def configure(services: dict[str, dict[str, Any]]) -> None:
    for name, cfg in services.items():
        ROOTS[name] = Path(cfg["root"])
        LABELS[name] = cfg.get("label", name)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)


# ---- addressing ----

def _split(item_id: str) -> tuple[str, str]:
    svc, sep, rel = str(item_id).partition(":")
    if not sep or svc not in ROOTS or not rel:
        raise HTTPException(400, f"bad item id: {item_id!r}")
    return svc, rel


def _resolve(svc: str, rel: str) -> Path:
    root = ROOTS[svc].resolve()
    p = (root / rel).resolve()
    if p != root and root not in p.parents:
        raise HTTPException(400, "path escapes the library root")
    return p


def _posted_at(name: str) -> int | None:
    m = POSTED_RE.search(name)
    if not m:
        return None
    y, mo, d, h, mi = (int(x) for x in m.groups())
    try:
        import calendar
        return calendar.timegm((y, mo, d, h, mi, 0))
    except Exception:
        return None


def _member_key(svc: str, rel: str) -> str:
    return f"{PREFIX[svc]}:{os.path.splitext(os.path.basename(rel))[0]}"


# ---- scan ----

def _do_scan() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for svc, root in ROOTS.items():
        if not root.is_dir():
            continue
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                ext = os.path.splitext(f)[1].lower()
                is_video = ext in VIDEO_EXTS
                if not is_video and ext not in IMAGE_EXTS:
                    continue
                full = os.path.join(dirpath, f)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, root)
                parts = rel.split(os.sep)
                if len(parts) < 2:      # loose file directly under the root: no creator folder
                    continue
                out.append({
                    "id": f"{svc}:{rel}",
                    "svc": svc,
                    "rel": rel,
                    "name": f,
                    "creator": parts[0],
                    "section": "/".join(parts[1:-1]),
                    "is_video": 1 if is_video else 0,
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                    "posted_at": _posted_at(f),
                    "key": _member_key(svc, rel),
                })
    return out


def _items(force: bool = False) -> list[dict[str, Any]]:
    with _scan_lock:
        if force or time.time() - _scan["at"] > SCAN_TTL:
            t0 = time.time()
            _scan["items"] = _do_scan()
            _scan["at"] = time.time()
            log.info("library scan: %d files in %.1fs", len(_scan["items"]), time.time() - t0)
        return _scan["items"]


def _dims_of(item: dict[str, Any]) -> tuple[int, int] | None:
    if item["is_video"]:
        return None
    if item["id"] in _dims:
        return _dims[item["id"]]
    dims = None
    try:
        from PIL import Image
        with Image.open(_resolve(item["svc"], item["rel"])) as im:
            dims = im.size
    except Exception as e:
        log.warning("dims %s: %s", item["id"], e)
    _dims[item["id"]] = dims
    return dims


# ---- listing ----

@router.get("/creators")
def creators():
    acc: dict[tuple[str, str], dict[str, Any]] = {}
    for it in _items():
        c = acc.setdefault((it["svc"], it["creator"]), {
            "svc": it["svc"], "svc_label": LABELS[it["svc"]], "creator": it["creator"], "images": 0, "videos": 0})
        c["videos" if it["is_video"] else "images"] += 1
    rows = sorted(acc.values(), key=lambda c: (c["svc"], c["creator"].lower()))
    return {"creators": rows}


@router.get("/items")
def items(svc: str = "", creator: str = "", sort: str = "newest", videos: bool = False,
          q: str = "", page: int = 1, per_page: int = 60, refresh: bool = False):
    rows = _items(force=refresh)
    if svc:
        rows = [r for r in rows if r["svc"] == svc]
    if creator:
        rows = [r for r in rows if r["creator"] == creator]
    if not videos:
        rows = [r for r in rows if not r["is_video"]]
    if q.strip():
        ql = q.strip().lower()
        rows = [r for r in rows if ql in r["rel"].lower()]
    when = lambda r: r["posted_at"] or r["mtime"]   # noqa: E731
    if sort == "oldest":
        rows = sorted(rows, key=when)
    elif sort == "recent":
        rows = sorted(rows, key=lambda r: r["mtime"], reverse=True)
    elif sort == "largest":
        rows = sorted(rows, key=lambda r: r["size"], reverse=True)
    elif sort == "name":
        rows = sorted(rows, key=lambda r: r["rel"].lower())
    else:
        rows = sorted(rows, key=when, reverse=True)
    per_page = max(1, min(int(per_page or 60), 500))
    total = len(rows)
    total_pages = max(1, (total + per_page - 1) // per_page)
    page = min(max(1, int(page or 1)), total_pages)
    chunk = [dict(r) for r in rows[(page - 1) * per_page: page * per_page]]
    for r in chunk:
        d = _dims_of(r)
        r["width"], r["height"] = (d if d else (None, None))
    return {"items": chunk, "total": total, "page": page, "total_pages": total_pages}


# ---- files ----

@router.get("/file")
def file(id: str = Query(...)):
    svc, rel = _split(id)
    p = _resolve(svc, rel)
    if not p.is_file():
        return Response(status_code=404)
    return FileResponse(p, headers={"Cache-Control": "private, max-age=86400"})


def _thumb_path(svc: str, rel: str, mtime: int) -> Path:
    h = hashlib.sha1(f"{svc}:{rel}:{mtime}".encode()).hexdigest()
    return THUMB_DIR / f"{h}.jpg"


def _make_thumb(src: Path, dst: Path, is_video: bool) -> bool:
    from PIL import Image, ImageOps
    tmp = dst.with_suffix(".tmp.jpg")
    try:
        if is_video:
            # a frame ~1s in (falls back to the first frame on very short clips)
            for ss in ("1", "0"):
                r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", ss, "-i", str(src), "-frames:v", "1",
                                    "-vf", "scale=420:420:force_original_aspect_ratio=decrease", str(tmp)],
                                   capture_output=True, timeout=60)
                if r.returncode == 0 and tmp.is_file() and tmp.stat().st_size > 0:
                    os.replace(tmp, dst)
                    return True
            log.warning("video thumb %s: %s", src, r.stderr.decode(errors="replace")[-300:])
            return False
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((420, 420))
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(tmp, "JPEG", quality=82)
        os.replace(tmp, dst)
        return True
    except Exception as e:
        log.warning("thumb %s: %s", src, e)
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        return False


@router.get("/thumb")
def thumb(id: str = Query(...)):
    svc, rel = _split(id)
    p = _resolve(svc, rel)
    try:
        st = p.stat()
    except OSError:
        return Response(status_code=404)
    dst = _thumb_path(svc, rel, int(st.st_mtime))
    if not dst.is_file():
        if not _make_thumb(p, dst, os.path.splitext(rel)[1].lower() in VIDEO_EXTS):
            return Response(status_code=404)
    return FileResponse(dst, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})


@router.post("/delete")
def delete(body: dict = Body(...)):
    ids = body.get("ids") or []
    deleted, errors = 0, []
    for item_id in ids:
        try:
            svc, rel = _split(item_id)
            p = _resolve(svc, rel)
            mtime = int(p.stat().st_mtime) if p.exists() else 0
            p.unlink(missing_ok=True)
            _thumb_path(svc, rel, mtime).unlink(missing_ok=True)
            _dims.pop(item_id, None)
            deleted += 1
            log.info("deleted %s", item_id)
        except HTTPException as e:
            errors.append(f"{item_id}: {e.detail}")
        except Exception as e:
            errors.append(f"{item_id}: {e}")
            log.warning("delete %s: %s", item_id, e)
    _items(force=True)
    return {"ok": True, "deleted": deleted, "errors": errors[:10]}


# ---- training sets ----

def _slug_setname(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._ -]+", "", (name or "").strip())
    s = re.sub(r"\s+", "_", s).strip("._-")
    return s[:80]


def _ledger_read(d: str) -> dict:
    try:
        with open(os.path.join(d, LEDGER)) as fh:
            return dict(json.load(fh).get("items") or {})
    except FileNotFoundError:
        return {}
    except Exception as e:
        log.warning("ledger %s: %s", d, e)
        return {}


def _ledger_add(d: str, entries: dict) -> None:
    cur = _ledger_read(d)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for k, rel in entries.items():
        cur.setdefault(k, {"file": rel, "at": now})
    tmp = os.path.join(d, LEDGER + ".tmp")
    with open(tmp, "w") as fh:
        json.dump({"items": dict(sorted(cur.items()))}, fh, indent=1)
    os.replace(tmp, os.path.join(d, LEDGER))
    try:
        os.chmod(os.path.join(d, LEDGER), 0o666)
    except Exception:
        pass


def _set_members(d: str) -> set:
    keys = set(_ledger_read(d))
    for _root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        for f in files:
            m = MEMBER_RE.match(f)
            if m:
                keys.add(f"{m.group(1)}:{m.group(2)}")
    return keys


def _all_set_dirs():
    out = []
    for root, prefix in ((TRAINING_IMAGES_ROOT, ""), (BATCHES_ROOT, "batch: ")):
        try:
            for e in sorted(os.listdir(root)):
                p = os.path.join(root, e)
                if os.path.isdir(p) and not e.startswith("."):
                    out.append((prefix + e, p))
        except FileNotFoundError:
            pass
    return out


@router.get("/training-sets")
def training_sets():
    sets = []
    try:
        for entry in sorted(os.listdir(TRAINING_IMAGES_ROOT)):
            p = os.path.join(TRAINING_IMAGES_ROOT, entry)
            if not os.path.isdir(p) or entry.startswith((".", "_")):
                continue
            try:
                count = sum(1 for f in os.listdir(p) if os.path.splitext(f)[1].lower() in IMAGE_EXTS)
            except Exception:
                count = 0
            sets.append({"name": entry, "count": count})
    except FileNotFoundError:
        pass
    return {"sets": sets}


@router.get("/training-sets/members")
def training_set_members(set: str = ""):
    name = _slug_setname(set)
    keys: list[str] = []
    if name:
        d = os.path.join(TRAINING_IMAGES_ROOT, name)
        if os.path.isdir(d):
            keys = sorted(_set_members(d))
    return {"set": name, "keys": keys}


@router.get("/training-sets/members-all")
def training_set_members_all():
    acc: dict = {}
    for label, p in _all_set_dirs():
        for k in _set_members(p):
            acc.setdefault(k, []).append(label)
    return {"members": acc}


@router.post("/training-sets/create")
def training_set_create(body: dict = Body(...)):
    name = _slug_setname(str(body.get("name") or ""))
    if not name:
        raise HTTPException(400, "name required")
    path = os.path.join(TRAINING_IMAGES_ROOT, name)
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o777)
    except Exception:
        pass
    return {"ok": True, "name": name}


@router.post("/training-sets/add")
def training_set_add(body: dict = Body(...)):
    """Copy library files (by item id) into a training set as <prefix>_<stem>.<ext>."""
    set_name = _slug_setname(str(body.get("set") or ""))
    ids = body.get("ids") or []
    if not set_name or not isinstance(ids, list) or not ids:
        raise HTTPException(400, "set and ids required")
    dest_dir = os.path.join(TRAINING_IMAGES_ROOT, set_name)
    os.makedirs(dest_dir, exist_ok=True)
    have = _set_members(dest_dir)
    added = skipped = already = 0
    errors, new_entries = [], {}
    for item_id in ids:
        try:
            svc, rel = _split(item_id)
            ext = os.path.splitext(rel)[1].lower()
            if ext not in IMAGE_EXTS:
                skipped += 1
                continue
            key = _member_key(svc, rel)
            if key in have:
                already += 1
                skipped += 1
                continue
            src = _resolve(svc, rel)
            if not src.is_file():
                skipped += 1
                continue
            stem = os.path.splitext(os.path.basename(rel))[0]
            dest = os.path.join(dest_dir, f"{PREFIX[svc]}_{stem}{ext}")
            if os.path.exists(dest):
                skipped += 1
                continue
            shutil.copy2(src, dest)
            try:
                os.chmod(dest, 0o664)
            except Exception:
                pass
            new_entries[key] = os.path.basename(dest)
            have.add(key)
            added += 1
        except HTTPException as e:
            errors.append(f"{item_id}: {e.detail}")
        except Exception as e:
            errors.append(f"{item_id}: {e}")
            log.warning("training add %s: %s", item_id, e)
    if new_entries:
        try:
            _ledger_add(dest_dir, new_entries)
        except Exception as e:
            errors.append(f"ledger: {e}")
    return {"ok": True, "set": set_name, "added": added, "skipped": skipped, "already_in_set": already,
            "errors": errors[:10]}
