"""Social scraper addon: Instagram + X/Twitter + RedGIFs + Bluesky accounts -> local library -> training sets.

One service, all sites. Site-scoped routes live under /{site}/ (site = instagram | twitter | redgifs | bluesky); the
Addons tab shows each site as its own addon (registry basePath /addons/social/<site>).
Downloading is gallery-dl (see worker.py). Login cookies are stored in data/social.db and are never
returned by any route - /settings reports only which cookie NAMES are present.
"""

import asyncio
import io
import json
import logging
import os
import re
import shutil
import time
import zipfile

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response

import db
from worker import REQUIRED_COOKIES, normalize_handle, parse_cookies, worker

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("social")

TRAINING_IMAGES_ROOT = os.environ.get("TRAINING_IMAGES_ROOT", "/imagegen/training_images")
BATCHES_ROOT = os.environ.get("TRAINING_BATCHES_ROOT", "/imagegen/_batches")
THUMB_DIR = os.path.join(db.DATA_DIR, "thumbs")
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
PREFIX = {"instagram": "ig", "twitter": "x", "redgifs": "rg", "bluesky": "bsky"}          # training-set filename prefix per site
LEDGER = ".social-members.json"
MEMBER_RE = re.compile(r"^(ig|x|rg|bsky)_(.+)\.[A-Za-z0-9]+$")

app = FastAPI(title="Social scraper")


@app.on_event("startup")
async def _startup():
    await asyncio.to_thread(db.get_settings)   # creates the schema
    os.makedirs(THUMB_DIR, exist_ok=True)
    worker.start()


@app.on_event("shutdown")
async def _shutdown():
    await worker.stop()


def _site(site: str):
    if site not in db.SITES:
        return None
    return worker.runners[site]


def _bad_site():
    return JSONResponse({"ok": False, "error": "unknown site"}, status_code=404)


async def _form(request: Request) -> dict:
    ct = request.headers.get("content-type", "")
    if "json" in ct:
        try:
            return await request.json()
        except Exception:
            return {}
    return dict(await request.form())


def _media_key(row: dict) -> str:
    """Stable id of one downloaded file, also used for training-set membership: '<prefix>:<stem>'."""
    stem = os.path.splitext(os.path.basename(row["rel"]))[0]
    return f"{PREFIX[row['site']]}:{stem}"


def _cookie_info(site: str, settings: dict) -> dict:
    names = sorted(parse_cookies(settings.get(f"{site}.cookies", "")))
    need = REQUIRED_COOKIES[site]
    return {"names": names, "required": list(need), "missing": [n for n in need if n not in names],
            "set": bool(names)}


EXT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension")


@app.get("/extension.zip")
async def extension_zip():
    """The 'AI-Lab Login Bridge' browser extension (load unpacked): one click sends this browser's
    instagram.com / x.com cookies to /<site>/api/cookies. It can read no other site's cookies."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(EXT_DIR)):
            z.write(os.path.join(EXT_DIR, name), f"ailab-login-bridge/{name}")
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="ailab-login-bridge.zip"'})


@app.get("/health")
async def health():
    return {"ok": True}


# ---- site views ----

@app.get("/{site}/")
async def dashboard(site: str):
    r = _site(site)
    if not r:
        return _bad_site()
    settings = await asyncio.to_thread(db.get_settings)
    return {
        "site": site,
        "worker": r.status(),
        "stats": await asyncio.to_thread(db.site_stats, site),
        "accounts": await asyncio.to_thread(db.list_accounts, site),
        "cookies": _cookie_info(site, settings),
        "poll_interval_h": settings.get("poll_interval_h"),
    }


@app.get("/{site}/log")
async def site_log(site: str):
    r = _site(site)
    if not r:
        return _bad_site()
    return {"lines": list(r.log)}


@app.get("/{site}/browser")
async def browser(site: str, account: int = Query(default=0), page: int = Query(default=1, ge=1),
                  per_page: int = Query(default=60, ge=1, le=200), sort: str = Query(default="newest"),
                  videos: bool = Query(default=False), q: str = Query(default=""), kind: str = Query(default="")):
    if not _site(site):
        return _bad_site()
    if kind not in ("", "all", "images", "videos"):
        kind = ""
    items, total = await asyncio.to_thread(db.browse, site, account or None, page, per_page, sort, videos, q.strip(), kind)
    for it in items:
        it["key"] = _media_key({"site": site, "rel": it["rel"]})
    return {"items": items, "total": total, "page": page, "per_page": per_page,
            "total_pages": (total + per_page - 1) // per_page,
            "accounts": [{"id": a["id"], "handle": a["handle"], "n_media": a["n_media"]}
                         for a in await asyncio.to_thread(db.list_accounts, site)]}


@app.get("/media/{mid}")
async def media_detail(mid: int):
    m = await asyncio.to_thread(db.get_media, mid)
    if not m:
        return JSONResponse({"error": "not found"}, status_code=404)
    m["key"] = _media_key(m)
    return m


@app.get("/{site}/settings")
async def settings_view(site: str):
    if not _site(site):
        return _bad_site()
    s = await asyncio.to_thread(db.get_settings)
    public = {k: v for k, v in s.items() if not k.endswith(".cookies")}
    return {"settings": public, "cookies": _cookie_info(site, s)}


# ---- actions ----

@app.post("/{site}/api/accounts/add")
async def accounts_add(site: str, request: Request):
    r = _site(site)
    if not r:
        return _bad_site()
    f = await _form(request)
    raw = str(f.get("handles") or f.get("handle") or "")
    added, bad = [], []
    for piece in re.split(r"[\s,]+", raw):
        if not piece:
            continue
        h = normalize_handle(site, piece)
        if not h:
            bad.append(piece)
            continue
        aid = await asyncio.to_thread(db.add_account, site, h)
        r.enqueue(aid)
        added.append(h)
    if not added and not bad:
        return JSONResponse({"ok": False, "error": "handle required"}, status_code=400)
    return {"ok": bool(added), "added": added, "invalid": bad,
            **({"error": f"not a valid {site} handle: {', '.join(bad)}"} if bad and not added else {})}


@app.post("/{site}/api/accounts/remove")
async def accounts_remove(site: str, request: Request):
    r = _site(site)
    if not r:
        return _bad_site()
    f = await _form(request)
    aid = int(f.get("id") or 0)
    acct = await asyncio.to_thread(db.get_account, aid)
    if not acct or acct["site"] != site:
        return JSONResponse({"ok": False, "error": "account not found"}, status_code=404)
    if r.current and r.current.get("account_id") == aid:
        await r.cancel()
    if aid in r.queue:
        r.queue.remove(aid)
    removed_files = False
    if str(f.get("delete_files") or "0") == "1":
        storage = await asyncio.to_thread(db.get_setting, "storage_path")
        target = os.path.join(storage, site, acct["handle"])
        # only ever a handle-named folder directly under <storage>/<site>
        if acct["handle"] and os.path.dirname(os.path.abspath(target)) == os.path.abspath(os.path.join(storage, site)):
            await asyncio.to_thread(shutil.rmtree, target, True)
            removed_files = True
    await asyncio.to_thread(db.remove_account, aid)
    return {"ok": True, "deleted_files": removed_files}


@app.post("/{site}/api/accounts/toggle")
async def accounts_toggle(site: str, request: Request):
    if not _site(site):
        return _bad_site()
    f = await _form(request)
    await asyncio.to_thread(db.update_account, int(f.get("id") or 0), enabled=1 if str(f.get("enabled", "1")) == "1" else 0)
    return {"ok": True}


@app.post("/{site}/api/accounts/sync")
async def accounts_sync(site: str, request: Request):
    r = _site(site)
    if not r:
        return _bad_site()
    f = await _form(request)
    aid = int(f.get("id") or 0)
    if str(f.get("full") or "0") == "1":     # re-walk the whole history (archive still skips what we have)
        await asyncio.to_thread(db.update_account, aid, complete=0)
    r.enqueue(aid, front=True)
    return {"ok": True}


@app.post("/{site}/api/sync-all")
async def sync_all(site: str):
    r = _site(site)
    if not r:
        return _bad_site()
    n = 0
    for a in await asyncio.to_thread(db.list_accounts, site):
        if a["enabled"]:
            r.enqueue(a["id"])
            n += 1
    return {"ok": True, "queued": n}


@app.post("/{site}/api/cancel")
async def cancel(site: str):
    r = _site(site)
    if not r:
        return _bad_site()
    await r.cancel()
    return {"ok": True}


@app.post("/{site}/api/pause")
async def pause(site: str, request: Request):
    r = _site(site)
    if not r:
        return _bad_site()
    f = await _form(request)
    paused = str(f.get("action", "pause")) == "pause"
    await asyncio.to_thread(db.set_settings, {f"{site}.paused": "1" if paused else "0"})
    if not paused:
        r.wake.set()
    return {"ok": True, "paused": paused}


SITE_KEYS = {
    "instagram": {"instagram.include", "instagram.sleep"},
    "twitter": {"twitter.sleep", "twitter.retweets"},
    "redgifs": {"redgifs.sleep"},
    "bluesky": {"bluesky.sleep", "bluesky.reposts", "bluesky.fast"},
}
GLOBAL_KEYS = {"storage_path", "poll_interval_h", "include_videos", "first_sync_limit"}


@app.post("/{site}/api/settings")
async def save_settings(site: str, request: Request):
    if not _site(site):
        return _bad_site()
    f = await _form(request)
    allowed = GLOBAL_KEYS | SITE_KEYS[site]
    upd = {k: str(v).strip() for k, v in f.items() if k in allowed}
    if "storage_path" in upd and not os.path.isabs(upd["storage_path"]):
        return JSONResponse({"ok": False, "error": "storage path must be absolute"}, status_code=400)
    await asyncio.to_thread(db.set_settings, upd)
    return {"ok": True, "saved": sorted(upd)}


@app.post("/{site}/api/cookies")
async def save_cookies(site: str, request: Request):
    if not _site(site):
        return _bad_site()
    f = await _form(request)
    text = str(f.get("cookies") or "")
    parsed = parse_cookies(text)
    if not parsed:
        return JSONResponse({"ok": False, "error": "no cookies found in that text"}, status_code=400)
    # store as a JSON dict: normalised, and the original paste (often a whole browser export) is dropped
    await asyncio.to_thread(db.set_settings, {f"{site}.cookies": json.dumps(parsed)})
    return {"ok": True, "cookies": _cookie_info(site, {f"{site}.cookies": json.dumps(parsed)})}


@app.post("/{site}/api/cookies/clear")
async def clear_cookies(site: str):
    if not _site(site):
        return _bad_site()
    await asyncio.to_thread(db.del_setting, f"{site}.cookies")
    return {"ok": True}


@app.post("/{site}/api/rescan")
async def rescan(site: str):
    r = _site(site)
    if not r:
        return _bad_site()
    storage = await asyncio.to_thread(db.get_setting, "storage_path")
    total = 0
    for a in await asyncio.to_thread(db.list_accounts, site):
        total += await asyncio.to_thread(r.rescan_account, a["id"], a["handle"], storage)
    return {"ok": True, "indexed": total}


@app.post("/api/media/delete")
async def media_delete(request: Request):
    """Delete files from the library. The download archive remembers them, so a sync won't refetch."""
    f = await _form(request)
    ids = [int(i) for i in (f.get("ids") or []) if str(i).isdigit()]
    storage = await asyncio.to_thread(db.get_setting, "storage_path")
    done = []
    for mid in ids:
        m = await asyncio.to_thread(db.get_media, mid)
        if not m:
            continue
        p = os.path.join(storage, m["rel"])
        for victim in (p, os.path.join(os.path.dirname(p), ".meta", os.path.basename(p) + ".json"),
                       os.path.join(THUMB_DIR, f"{mid}.jpg")):
            try:
                os.unlink(victim)
            except FileNotFoundError:
                pass
            except Exception as e:
                log.warning("delete %s: %s", victim, e)
        done.append(mid)
    await asyncio.to_thread(db.delete_media_rows, done)
    return {"ok": True, "deleted": len(done)}


# ---- media files ----

def _path_of(m: dict, storage: str) -> str:
    return os.path.join(storage, m["rel"])


@app.get("/file/full/{mid}")
async def file_full(mid: int):
    m = await asyncio.to_thread(db.get_media, mid)
    if not m:
        return Response(status_code=404)
    p = _path_of(m, await asyncio.to_thread(db.get_setting, "storage_path"))
    if not os.path.isfile(p):
        return Response(status_code=404)
    return FileResponse(p, headers={"Cache-Control": "private, max-age=86400"})


def _make_thumb(src: str, dst: str) -> bool:
    from PIL import Image, ImageOps
    try:
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((420, 420))
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            tmp = dst + ".tmp"
            im.save(tmp, "JPEG", quality=82)
            os.replace(tmp, dst)
        return True
    except Exception as e:
        log.warning("thumb %s: %s", src, e)
        return False


def _make_video_thumb(src: str, dst: str) -> bool:
    """Poster frame for a clip: ffmpeg at 1 s, then 0 s for clips shorter than that."""
    import subprocess
    tmp = dst + ".tmp.jpg"
    for ss in ("1", "0"):
        try:
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", ss, "-i", src, "-frames:v", "1",
                            "-vf", "scale='min(420,iw)':-2", "-q:v", "4", tmp], timeout=30, check=True)
            if os.path.getsize(tmp) > 0:
                os.replace(tmp, dst)
                return True
        except Exception as e:
            log.warning("video thumb %s @%ss: %s", src, ss, e)
    try:
        os.remove(tmp)
    except OSError:
        pass
    return False


@app.get("/file/thumb/{mid}")
async def file_thumb(mid: int):
    dst = os.path.join(THUMB_DIR, f"{mid}.jpg")
    if not os.path.isfile(dst):
        m = await asyncio.to_thread(db.get_media, mid)
        if not m:
            return Response(status_code=404)
        src = _path_of(m, await asyncio.to_thread(db.get_setting, "storage_path"))
        if not await asyncio.to_thread(_make_video_thumb if m["is_video"] else _make_thumb, src, dst):
            return Response(status_code=404)
    return FileResponse(dst, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})


# ---- training sets (same model as the rule34 addon: per-set ledger + recursive filename scan) ----

def _slug_setname(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._ -]+", "", (name or "").strip())
    s = re.sub(r"\s+", "_", s).strip("._-")
    return s[:80]


def _ledger_read(d: str) -> dict:
    try:
        with open(os.path.join(d, LEDGER)) as fh:
            return dict(json.load(fh).get("items") or {})
    except Exception:
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
    for root, dirs, files in os.walk(d):
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


@app.get("/api/training-sets")
async def training_sets():
    def scan():
        sets = []
        try:
            for entry in sorted(os.listdir(TRAINING_IMAGES_ROOT)):
                p = os.path.join(TRAINING_IMAGES_ROOT, entry)
                if not os.path.isdir(p) or entry.startswith((".", "_")):
                    continue
                try:
                    count = sum(1 for f in os.listdir(p) if f.lower().endswith(IMAGE_EXTS))
                except Exception:
                    count = 0
                sets.append({"name": entry, "count": count})
        except FileNotFoundError:
            pass
        return sets
    return {"sets": await asyncio.to_thread(scan)}


@app.get("/api/training-sets/members")
async def training_set_members(set: str = Query(default="")):
    name = _slug_setname(set)
    keys = []
    if name:
        d = os.path.join(TRAINING_IMAGES_ROOT, name)
        if os.path.isdir(d):
            keys = sorted(await asyncio.to_thread(_set_members, d))
    return {"set": name, "keys": keys}


@app.get("/api/training-sets/members-all")
async def training_set_members_all():
    def scan():
        acc: dict = {}
        for label, p in _all_set_dirs():
            for k in _set_members(p):
                acc.setdefault(k, []).append(label)
        return acc
    return {"members": await asyncio.to_thread(scan)}


@app.post("/api/training-sets/create")
async def training_set_create(request: Request):
    f = await _form(request)
    name = _slug_setname(str(f.get("name") or ""))
    if not name:
        return JSONResponse({"ok": False, "error": "name required"}, status_code=400)
    path = os.path.join(TRAINING_IMAGES_ROOT, name)
    try:
        os.makedirs(path, exist_ok=True)
        try:
            os.chmod(path, 0o777)
        except Exception:
            pass
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    return {"ok": True, "name": name}


@app.post("/api/training-sets/add-frame")
async def training_set_add_frame(request: Request):
    """Save one frame grabbed in the browser from a clip (or GIF) into a training set, as
    <prefix>_<stem>-t<ms>.png. The frame is captured client-side from the <video> element so what
    lands on disk is exactly the frame that was on screen. No ledger entry: the CLIP is not in the set."""
    import base64
    body = await request.json()
    set_name = _slug_setname(str(body.get("set") or ""))
    data = str(body.get("data") or "")
    try:
        mid = int(body.get("id"))
        ms = max(0, int(round(float(body.get("time") or 0) * 1000)))
    except (TypeError, ValueError):
        return JSONResponse({"ok": False, "error": "id and time must be numbers"}, status_code=400)
    m_ = re.match(r"^data:image/png;base64,([A-Za-z0-9+/=]+)$", data)
    if not set_name or not m_:
        return JSONResponse({"ok": False, "error": "set and a PNG data URL are required"}, status_code=400)
    m = await asyncio.to_thread(db.get_media, mid)
    if not m:
        return JSONResponse({"ok": False, "error": "no such media"}, status_code=404)
    raw = base64.b64decode(m_.group(1))
    if not raw:
        return JSONResponse({"ok": False, "error": "empty image"}, status_code=400)
    dest_dir = os.path.join(TRAINING_IMAGES_ROOT, set_name)
    stem = os.path.splitext(os.path.basename(m["rel"]))[0]
    name = f"{PREFIX[m['site']]}_{stem}-t{ms}.png"
    try:
        os.makedirs(dest_dir, exist_ok=True)
        with open(os.path.join(dest_dir, name), "wb") as fh:
            fh.write(raw)
        try:
            os.chmod(os.path.join(dest_dir, name), 0o664)
        except Exception:
            pass
    except Exception as e:
        log.warning("add-frame %s -> %s: %s", mid, set_name, e)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    log.info("frame %s (%d KB) from media %s @%dms -> %s", name, len(raw) // 1024, mid, ms, set_name)
    return {"ok": True, "set": set_name, "name": name}


@app.post("/api/training-sets/add")
async def training_set_add(request: Request):
    """Copy library files (by media id) into a training set as <ig|x>_<stem>.<ext>."""
    body = await request.json()
    set_name = _slug_setname(str(body.get("set") or ""))
    ids = body.get("ids") or []
    if not set_name or not isinstance(ids, list) or not ids:
        return JSONResponse({"ok": False, "error": "set and ids required"}, status_code=400)
    dest_dir = os.path.join(TRAINING_IMAGES_ROOT, set_name)
    try:
        os.makedirs(dest_dir, exist_ok=True)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    storage = await asyncio.to_thread(db.get_setting, "storage_path")
    have = await asyncio.to_thread(_set_members, dest_dir)
    added = skipped = already = 0
    errors, new_entries = [], {}
    for mid in ids:
        try:
            m = await asyncio.to_thread(db.get_media, int(mid))
            if not m or m["is_video"]:
                skipped += 1
                continue
            key = _media_key(m)
            if key in have:
                already += 1
                skipped += 1
                continue
            src = _path_of(m, storage)
            if not os.path.isfile(src):
                skipped += 1
                continue
            stem, ext = os.path.splitext(os.path.basename(src))
            dest = os.path.join(dest_dir, f"{PREFIX[m['site']]}_{stem}{ext.lower() or '.jpg'}")
            if os.path.exists(dest):
                skipped += 1
                continue
            await asyncio.to_thread(shutil.copy2, src, dest)
            try:
                os.chmod(dest, 0o664)
            except Exception:
                pass
            new_entries[key] = os.path.basename(dest)
            added += 1
        except Exception as e:
            errors.append(f"{mid}: {e}")
    if new_entries:
        try:
            await asyncio.to_thread(_ledger_add, dest_dir, new_entries)
        except Exception as e:
            errors.append(f"ledger: {e}")
    return {"ok": True, "set": set_name, "added": added, "skipped": skipped, "already_in_set": already,
            "errors": errors[:10]}
