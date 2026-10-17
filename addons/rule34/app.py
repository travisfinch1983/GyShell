"""FastAPI application for Rule34 scraper addon."""

import asyncio
import json
import time
import os
import re
import shutil
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, FileResponse, Response, StreamingResponse
import httpx

TRAINING_IMAGES_ROOT = os.environ.get("TRAINING_IMAGES_ROOT", "/imagegen/training_images")
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")


def _slug_setname(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._ -]+", "", (name or "").strip())
    s = re.sub(r"\s+", "_", s).strip("._-")
    return s[:80]


from db import (
    init_db,
    get_all_settings,
    update_settings,
    get_stats,
    get_watched_tags,
    get_watched_tag_names,
    add_watched_tag,
    remove_watched_tag,
    toggle_watched_tag,
    browse_posts,
    get_post,
    mark_for_redownload,
    search_tags,
    retry_failed_downloads,
    get_setting,
    get_tag_counts,
    list_api_keys,
    add_api_key,
    remove_api_key,
    set_api_key_enabled,
    get_sources_for_md5s,
)
from sites import SITES, site_status, danbooru_translate
from worker import worker
from scraper import media_headers, is_html_response

# Settings whose values are SECRETS: never returned by the settings view, and
# an empty submit never overwrites a stored value (the form round-trips).
SECRET_SETTINGS = {"danbooru_api_key", "gelbooru_api_key"}

logging.basicConfig(level=logging.INFO)
# httpx/httpcore log every request URL at INFO, and booru API URLs carry
# api_key/user_id query params, so those went to journald in the clear.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# One pooled client for the thumb/full proxies. A client per request meant a new
# TCP+TLS connection and a DNS lookup for every thumbnail in the grid.
_media_client: httpx.AsyncClient | None = None


def media_client() -> httpx.AsyncClient:
    global _media_client
    if _media_client is None or _media_client.is_closed:
        _media_client = httpx.AsyncClient(
            follow_redirects=True, timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16))
    return _media_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await worker.start()
    yield
    await worker.stop()


app = FastAPI(title="Rule34 Scraper", lifespan=lifespan)


# --- View routes ---


@app.get("/")
async def dashboard(format: str = Query(default=None)):
    stats = await get_stats()
    watched = await get_watched_tags()
    data = {
        "worker": worker.status,
        "stats": stats,
        "watched_tags": watched,
    }
    if format == "json":
        return JSONResponse(data)
    return JSONResponse(data)


@app.get("/browser")
async def browser(
    tags: str = Query(default=None),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=40, ge=1, le=100),
    sort: str = Query(default="newest"),
    rating: str = Query(default=None),
    downloaded_only: bool = Query(default=False),
    sites: str = Query(default=None),
    format: str = Query(default=None),
):
    site_list = [x.strip() for x in (sites or "").split(",") if x.strip() in SITES] or None
    posts, total = await browse_posts(
        tags=tags,
        page=page,
        per_page=per_page,
        sort=sort,
        rating=rating,
        downloaded_only=downloaded_only,
        sites=site_list,
    )
    # Badges: every site each image exists on (by md5), regardless of filter —
    # a deduped card shows ALL its sources; the filter only decides visibility.
    src_map = await get_sources_for_md5s([p.get("md5") for p in posts if p.get("md5")])
    for p in posts:
        p["sources"] = src_map.get(p.get("md5")) or [
            {"site": p.get("site", "rule34"), "site_post_id": p.get("site_post_id"),
             "post_id": p["id"], "downloaded": p.get("downloaded")}]
    # Sidebar tags = watched tags (always visible) + tags on THIS page's posts
    # (mirrors rule34.xxx). Each carries its global post_count for display.
    watched_names = await get_watched_tag_names()
    watched_set = set(watched_names)
    page_names: list[str] = []
    seen = set(watched_set)
    for p in posts:
        for t in (p.get("tags") or "").split():
            if t not in seen:
                seen.add(t)
                page_names.append(t)
    all_names = watched_names + page_names
    counts = await get_tag_counts(all_names)
    sidebar_tags = [
        {"name": n, "post_count": counts.get(n, 0), "watched": n in watched_set}
        for n in all_names
    ]
    data = {
        "posts": posts,
        "total": total,
        "page": page,
        "per_page": per_page,
        "total_pages": (total + per_page - 1) // per_page if per_page else 0,
        "sidebar_tags": sidebar_tags,
    }
    # Danbooru's 2-tag search limit (free accounts): the scraper uses the first
    # two tags as listed (Travis's rule) — tell the UI when that applies.
    if tags:
        _dt, _used, _trunc = danbooru_translate(tags)
        if _trunc:
            data["danbooru_tags_used"] = _used
    if format == "json":
        return JSONResponse(data)
    return JSONResponse(data)


@app.get("/browser/post/{post_id}")
async def post_detail(post_id: int, format: str = Query(default=None)):
    post = await get_post(post_id)
    if not post:
        return JSONResponse({"error": "Post not found"}, status_code=404)
    if post.get("md5"):
        src = await get_sources_for_md5s([post["md5"]])
        post["sources"] = src.get(post["md5"]) or []
    # Viewing a post bumps its still-untyped tags to the front of the typing
    # queue so artist/character labels fill in within seconds.
    untyped = post.get("untyped_tags")
    if untyped:
        worker.request_tag_types(untyped)
    if format == "json":
        return JSONResponse(post)
    return JSONResponse(post)


@app.get("/tags")
async def tags_view(format: str = Query(default=None)):
    watched = await get_watched_tags()
    data = {"watched_tags": watched}
    if format == "json":
        return JSONResponse(data)
    return JSONResponse(data)


@app.get("/tags/search")
async def tag_search(q: str = Query(default=""), limit: int = Query(default=20)):
    results = await search_tags(q, limit)
    return JSONResponse(results)


@app.get("/settings")
async def settings_view(format: str = Query(default=None)):
    settings = await get_all_settings()
    settings.pop("api_key", None)  # pool is the source of truth for credentials
    # Secrets never leave the backend; the UI gets a set/unset flag instead.
    for k in SECRET_SETTINGS:
        settings[f"{k}_set"] = "1" if (settings.pop(k, "") or "").strip() else "0"
    settings["site_status"] = site_status
    keys = await list_api_keys()
    enabled = [k for k in keys if k["enabled"]]
    per_key = int(settings.get("rate_limit_requests", "60") or "60")
    window = int(settings.get("rate_limit_window_sec", "60") or "60")
    data = {
        "settings": settings,
        "api_keys": keys,
        "rate_info": {
            "enabled_keys": len(enabled),
            "per_key_requests": per_key,
            "window_sec": window,
            "effective_requests": len(enabled) * per_key,
        },
    }
    return JSONResponse(data)


# --- Action routes ---


@app.post("/api/tags/add")
async def api_add_tag(request: Request):
    form = await request.form()
    query = form.get("query", "").strip()
    if not query:
        return JSONResponse({"ok": False, "error": "query required"}, status_code=400)
    tag_id = await add_watched_tag(query)
    # Auto-scrape immediately so the user doesn't have to hit "Scrape Now"
    if tag_id:
        asyncio.create_task(worker.scrape_tag_now(query, tag_id, 0))
    return JSONResponse({"ok": True, "id": tag_id})


@app.post("/api/tags/remove")
async def api_remove_tag(request: Request):
    form = await request.form()
    tag_id = form.get("id")
    if not tag_id:
        return JSONResponse({"ok": False, "error": "id required"}, status_code=400)
    await remove_watched_tag(int(tag_id))
    return JSONResponse({"ok": True})


@app.post("/api/tags/toggle")
async def api_toggle_tag(request: Request):
    form = await request.form()
    tag_id = form.get("id")
    enabled = form.get("enabled", "1")
    if not tag_id:
        return JSONResponse({"ok": False, "error": "id required"}, status_code=400)
    await toggle_watched_tag(int(tag_id), enabled == "1")
    return JSONResponse({"ok": True})


@app.post("/api/tags/scrape-now")
async def api_scrape_tag_now(request: Request):
    form = await request.form()
    tag_id = form.get("id")
    if not tag_id:
        return JSONResponse({"ok": False, "error": "id required"}, status_code=400)
    # Find the tag query
    watched = await get_watched_tags()
    tag = next((t for t in watched if t["id"] == int(tag_id)), None)
    if not tag:
        return JSONResponse({"ok": False, "error": "tag not found"}, status_code=404)
    # Sync Now also makes the download loop prioritise this tag's images.
    worker._priority_tag_id = tag["id"]
    worker._priority_tag_query = tag["tag_query"]
    worker._current_download_tag = tag["tag_query"]
    asyncio.create_task(
        worker.scrape_tag_now(tag["tag_query"], tag["id"], tag["last_post_id"])
    )
    return JSONResponse({"ok": True})


@app.post("/api/watched-tags/backfill")
async def api_watched_backfill():
    from db import backfill_watched_tag_links, refresh_watched_agg
    n = await backfill_watched_tag_links()
    await refresh_watched_agg()
    return {"ok": True, "linked": n}


# --- Training-set membership (2026-10-08) -----------------------------------------------------------
# Membership used to be "an r34_<id>.<ext> file at the TOP LEVEL of the set folder". That lost every
# image the moment it was renamed (subsection moves -> concept-N, the bulk renamer) or sat in a nested
# training_set_* subfolder, so the green "already added" border vanished and the same post could be
# added twice. Now: a per-set LEDGER written at add time (survives renames/moves inside the set), plus
# a RECURSIVE r34_ name scan, plus a one-time content-hash backfill (backfill_set_ledgers.py).
BATCHES_ROOT = os.environ.get("TRAINING_BATCHES_ROOT", "/imagegen/_batches")
LEDGER = ".r34-members.json"


def _ledger_read(d):
    try:
        with open(os.path.join(d, LEDGER)) as fh:
            data = json.load(fh)
        return {int(k): v for k, v in (data.get("posts") or {}).items()}
    except Exception:
        return {}


def _ledger_add(d, entries):
    """entries: {post_id: relative file path}. Merged into the set's ledger."""
    cur = _ledger_read(d)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for pid, rel in entries.items():
        cur.setdefault(int(pid), {"file": rel, "at": now})
    tmp = os.path.join(d, LEDGER + ".tmp")
    with open(tmp, "w") as fh:
        json.dump({"posts": {str(k): v for k, v in sorted(cur.items())}}, fh, indent=1)
    os.replace(tmp, os.path.join(d, LEDGER))
    try:
        os.chmod(os.path.join(d, LEDGER), 0o666)
    except Exception:
        pass


def _set_members(d):
    """Post ids in a set: the ledger, plus any r34_<id> file anywhere below it (dot-dirs skipped)."""
    ids = set(_ledger_read(d))
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        for f in files:
            m = re.match(r"^r34_(\d+)(?:-\d+)?\.", f)
            if m:
                ids.add(int(m.group(1)))
    return ids


def _all_set_dirs():
    """(label, path) for every training set and every training batch."""
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


@app.get("/api/training-sets/members-all")
async def api_training_set_members_all():
    """{post_id: [set labels]} across every training set AND training batch."""
    def scan():
        acc = {}
        for label, p in _all_set_dirs():
            for pid in _set_members(p):
                acc.setdefault(pid, []).append(label)
        return acc
    acc = await asyncio.to_thread(scan)
    return JSONResponse({"members": {str(k): v for k, v in acc.items()}})


@app.get("/api/training-sets")
async def api_list_training_sets():
    """List training image sets (top-level folders under the imagegen training_images root)."""
    sets = []
    try:
        for entry in sorted(os.listdir(TRAINING_IMAGES_ROOT)):
            p = os.path.join(TRAINING_IMAGES_ROOT, entry)
            if not os.path.isdir(p) or entry.startswith((".", "_")):
                continue
            try:
                files = os.listdir(p)
                count = sum(1 for f in files if f.lower().endswith(IMAGE_EXTS))
                is_r34 = os.path.exists(os.path.join(p, ".rule34-set")) or any(f.startswith("r34_") for f in files)
            except Exception:
                count = 0
                is_r34 = False
            sets.append({"name": entry, "count": count, "rule34": is_r34})
    except FileNotFoundError:
        pass
    return JSONResponse({"sets": sets})


@app.get("/api/training-sets/members")
async def api_training_set_members(set: str = Query(default="")):
    """Post ids already in a training set: ledger + recursive r34_ scan (see _set_members)."""
    name = _slug_setname(set)
    ids = []
    if name:
        d = os.path.join(TRAINING_IMAGES_ROOT, name)
        if os.path.isdir(d):
            ids = sorted(await asyncio.to_thread(_set_members, d))
    return JSONResponse({"set": name, "post_ids": ids})


@app.post("/api/training-sets/create")
async def api_create_training_set(request: Request):
    form = await request.form()
    name = _slug_setname(form.get("name", ""))
    if not name:
        return JSONResponse({"ok": False, "error": "name required"}, status_code=400)
    path = os.path.join(TRAINING_IMAGES_ROOT, name)
    try:
        os.makedirs(path, exist_ok=True)
        try:
            os.chmod(path, 0o777)
        except Exception:
            pass
        try:
            open(os.path.join(path, ".rule34-set"), "a").close()
        except Exception:
            pass
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    return JSONResponse({"ok": True, "name": name})


@app.post("/api/training-sets/add")
async def api_add_to_training_set(request: Request):
    """Copy downloaded rule34 images (by post id) into a training set folder."""
    body = await request.json()
    set_name = _slug_setname(str(body.get("set", "")))
    post_ids = body.get("post_ids") or []
    if not set_name or not isinstance(post_ids, list) or not post_ids:
        return JSONResponse({"ok": False, "error": "set and post_ids required"}, status_code=400)
    dest_dir = os.path.join(TRAINING_IMAGES_ROOT, set_name)
    try:
        os.makedirs(dest_dir, exist_ok=True)
        try:
            os.chmod(dest_dir, 0o777)
        except Exception:
            pass
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    storage_path = await get_setting("storage_path") or "/mnt/shared/rule34"
    added = skipped = already = 0
    errors = []
    have = await asyncio.to_thread(_set_members, dest_dir)   # renamed/nested copies count too
    new_entries = {}
    for pid in post_ids:
        try:
            if int(pid) in have:
                already += 1
                skipped += 1
                continue
            post = await get_post(int(pid))
            if not post or post.get("downloaded") != 1 or not post.get("local_path"):
                skipped += 1
                continue
            src = os.path.join(storage_path, post["local_path"])
            if not os.path.isfile(src):
                skipped += 1
                continue
            ext = os.path.splitext(src)[1] or ".jpg"
            dest = os.path.join(dest_dir, f"r34_{int(pid)}{ext}")
            if os.path.exists(dest):
                skipped += 1
                continue
            shutil.copy2(src, dest)
            new_entries[int(pid)] = os.path.basename(dest)
            added += 1
        except Exception as e:
            errors.append(f"{pid}: {e}")
    if new_entries:
        try:
            _ledger_add(dest_dir, new_entries)
        except Exception as e:
            errors.append(f"ledger: {e}")
    return JSONResponse({"ok": True, "set": set_name, "added": added, "skipped": skipped,
                         "already_in_set": already, "errors": errors[:10]})


@app.post("/api/settings")
async def api_update_settings(request: Request):
    form = await request.form()
    updates = dict(form)
    # An empty secret field means "keep what is stored", never "erase" — the
    # settings form round-trips and the view can't echo the secret back.
    for k in SECRET_SETTINGS:
        if k in updates and not str(updates[k]).strip():
            updates.pop(k)
    updates.pop("site_status", None)
    for k in list(updates):
        if k.endswith("_set"):
            updates.pop(k)
    if updates:
        await update_settings(updates)
    return JSONResponse({"ok": True})


# --- API key pool management ---

@app.post("/api/keys/add")
async def api_keys_add(request: Request):
    form = await request.form()
    api_key = (form.get("api_key") or "").strip()
    user_id = (form.get("user_id") or "").strip()
    label = (form.get("label") or "").strip()
    proxy = (form.get("proxy") or "").strip()
    if not api_key or not user_id:
        return JSONResponse(
            {"ok": False, "error": "api_key and user_id are required"}, status_code=400
        )
    key_id = await add_api_key(api_key, user_id, label, proxy)
    return JSONResponse({"ok": True, "id": key_id})


@app.post("/api/keys/remove")
async def api_keys_remove(request: Request):
    form = await request.form()
    key_id = form.get("id")
    if not key_id:
        return JSONResponse({"ok": False, "error": "id required"}, status_code=400)
    await remove_api_key(int(key_id))
    return JSONResponse({"ok": True})


@app.post("/api/keys/toggle")
async def api_keys_toggle(request: Request):
    form = await request.form()
    key_id = form.get("id")
    enabled = form.get("enabled", "1")
    if not key_id:
        return JSONResponse({"ok": False, "error": "id required"}, status_code=400)
    await set_api_key_enabled(int(key_id), enabled == "1")
    return JSONResponse({"ok": True})


@app.post("/api/worker/pause")
async def api_worker_pause(request: Request):
    form = await request.form()
    action = form.get("action", "pause")
    if action == "pause":
        worker.pause()
    else:
        worker.resume()
    await update_settings({"worker_paused": "1" if worker.paused else "0"})
    return JSONResponse({"ok": True, "paused": worker.paused})


@app.post("/api/worker/scrape-all")
async def api_scrape_all():
    watched = await get_watched_tags()
    for wt in watched:
        if wt["enabled"]:
            asyncio.create_task(
                worker.scrape_tag_now(wt["tag_query"], wt["id"], wt["last_post_id"])
            )
    return JSONResponse({"ok": True, "count": len([w for w in watched if w["enabled"]])})


@app.post("/api/retry-failed")
async def api_retry_failed():
    await retry_failed_downloads()
    return JSONResponse({"ok": True})


# --- Media routes ---


def _is_html_file(path: str) -> bool:
    """A saved "image" that is really a web page (old hotlink-page downloads)."""
    try:
        with open(path, "rb") as f:
            head = f.read(512).lstrip().lower()
    except OSError:
        return False
    return head.startswith((b"<!doctype html", b"<html", b"<head"))


@app.get("/media/thumb/{post_id}")
async def media_thumb(post_id: int):
    post = await get_post(post_id)
    if not post:
        return Response(status_code=404)
    preview_url = post.get("preview_url")
    if not preview_url:
        return Response(status_code=404)
    # Proxy the thumbnail from rule34
    if True:
        client = media_client()
        try:
            resp = await client.get(preview_url, headers=media_headers(preview_url))
            resp.raise_for_status()
            if is_html_response(resp):
                logger.warning(f"thumb {post_id}: got an HTML page from {resp.url}")
                return Response(status_code=502)
            content_type = resp.headers.get("content-type", "image/jpeg")
            return Response(content=resp.content, media_type=content_type)
        except Exception as e:
            logger.warning(f"thumb {post_id}: fetch failed: {e}")
            return Response(status_code=502)


@app.get("/media/full/{post_id}")
async def media_full(post_id: int):
    post = await get_post(post_id)
    if not post:
        return Response(status_code=404)
    storage_path = await get_setting("storage_path") or "/mnt/shared/rule34"
    local_path = post.get("local_path")
    if post.get("downloaded") == 1 and local_path:
        full_path = os.path.join(storage_path, local_path)
        if os.path.isfile(full_path) and os.path.getsize(full_path) > 0 and not _is_html_file(full_path):
            return FileResponse(full_path)
        # Marked downloaded but the file is gone/empty/an HTML page — re-queue it
        # and fall through to serving the original so the viewer isn't broken.
        # The worker skips files that already exist, so a bad file must go first.
        if os.path.isfile(full_path) and _is_html_file(full_path):
            logger.warning(f"full {post_id}: {local_path} is an HTML page, removing and re-queueing")
            try:
                os.remove(full_path)
            except OSError as e:
                logger.warning(f"full {post_id}: could not remove {full_path}: {e}")
        try:
            await mark_for_redownload(post_id)
        except Exception:
            pass
    # Proxy the original from rule34 (same as /media/thumb), streamed so large
    # images/videos don't buffer fully in memory.
    remote = post.get("file_url") or post.get("sample_url")
    if not remote:
        return Response(status_code=404)
    client = media_client()
    try:
        req = client.build_request("GET", remote, headers=media_headers(remote))
        resp = await client.send(req, stream=True)
        resp.raise_for_status()
        if is_html_response(resp):
            await resp.aread()
            await resp.aclose()
            raise ValueError(f"got an HTML page from {resp.url}")
    except Exception as e:
        logger.warning(f"full {post_id}: remote fetch failed: {e}")
        return Response(status_code=502)
    media_type = resp.headers.get("content-type", "image/jpeg")

    async def _body():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()

    return StreamingResponse(_body(), media_type=media_type)
