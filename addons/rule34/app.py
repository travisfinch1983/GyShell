"""FastAPI application for Rule34 scraper addon."""

import asyncio
import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, FileResponse, Response
import httpx

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
    search_tags,
    retry_failed_downloads,
    get_setting,
    get_tag_counts,
    list_api_keys,
    add_api_key,
    remove_api_key,
    set_api_key_enabled,
)
from worker import worker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


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
    format: str = Query(default=None),
):
    posts, total = await browse_posts(
        tags=tags,
        page=page,
        per_page=per_page,
        sort=sort,
        rating=rating,
        downloaded_only=downloaded_only,
    )
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
    if format == "json":
        return JSONResponse(data)
    return JSONResponse(data)


@app.get("/browser/post/{post_id}")
async def post_detail(post_id: int, format: str = Query(default=None)):
    post = await get_post(post_id)
    if not post:
        return JSONResponse({"error": "Post not found"}, status_code=404)
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
    asyncio.create_task(
        worker.scrape_tag_now(tag["tag_query"], tag["id"], tag["last_post_id"])
    )
    return JSONResponse({"ok": True})


@app.post("/api/settings")
async def api_update_settings(request: Request):
    form = await request.form()
    updates = dict(form)
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


@app.get("/media/thumb/{post_id}")
async def media_thumb(post_id: int):
    post = await get_post(post_id)
    if not post:
        return Response(status_code=404)
    preview_url = post.get("preview_url")
    if not preview_url:
        return Response(status_code=404)
    # Proxy the thumbnail from rule34
    async with httpx.AsyncClient(follow_redirects=True) as client:
        try:
            resp = await client.get(preview_url)
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "image/jpeg")
            return Response(content=resp.content, media_type=content_type)
        except Exception:
            return Response(status_code=502)


@app.get("/media/full/{post_id}")
async def media_full(post_id: int):
    post = await get_post(post_id)
    if not post:
        return Response(status_code=404)
    if post.get("downloaded") != 1 or not post.get("local_path"):
        return Response(status_code=404)
    storage_path = await get_setting("storage_path") or "/mnt/shared/rule34"
    full_path = os.path.join(storage_path, post["local_path"])
    if not os.path.isfile(full_path):
        return Response(status_code=404)
    return FileResponse(full_path)
