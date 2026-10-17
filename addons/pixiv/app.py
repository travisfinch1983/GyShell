"""FastAPI app for the Pixiv scraper addon — same contract shape as rule34."""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from db import (
    init_db, get_all_settings, update_settings, get_setting, get_stats,
    get_watches, add_watch, remove_watch, toggle_watch, retry_failed,
    browse_illusts, get_illust,
)
from pixiv_client import status as auth_status
from worker import worker

logging.basicConfig(level=logging.INFO)
# httpx logs every request URL at INFO. On the rule34 addon that flooded
# journald (~20k lines/hour) and wrote booru api_keys into the log; pixiv
# URLs carry no secrets (auth rides a header) but the flood is the same.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# The refresh token is a SECRET: the view returns a set/unset flag and an
# empty submit keeps the stored value (same contract as the rule34 addon).
SECRET_SETTINGS = {"pixiv_refresh_token"}

PXIMG_HEADERS = {"Referer": "https://app-api.pixiv.net/",
                 "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await worker.start()
    yield
    await worker.stop()


app = FastAPI(title="Pixiv Scraper", lifespan=lifespan)


@app.get("/")
async def dashboard(format: str = Query(default=None)):
    return JSONResponse({
        "worker": worker.status,
        "stats": await get_stats(),
        "watches": await get_watches(),
    })


@app.get("/browser")
async def browser(
    q: str = Query(default=None),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=40, ge=1, le=100),
    sort: str = Query(default="newest"),
    artist_id: int = Query(default=None),
    restrict: str = Query(default=None),
    format: str = Query(default=None),
):
    illusts, total = await browse_illusts(q=q, page=page, per_page=per_page, sort=sort,
                                          artist_id=artist_id, restrict=restrict)
    for il in illusts:
        try:
            il["tag_list"] = json.loads(il.get("tags") or "[]")
        except Exception:
            il["tag_list"] = []
    return JSONResponse({
        "posts": illusts, "total": total, "page": page, "per_page": per_page,
        "total_pages": (total + per_page - 1) // per_page if per_page else 0,
    })


@app.get("/browser/post/{illust_id}")
async def post_detail(illust_id: int, format: str = Query(default=None)):
    il = await get_illust(illust_id)
    if not il:
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        il["tag_list"] = json.loads(il.get("tags") or "[]")
    except Exception:
        il["tag_list"] = []
    return JSONResponse(il)


@app.get("/settings")
async def settings_view(format: str = Query(default=None)):
    settings = await get_all_settings()
    for k in SECRET_SETTINGS:
        settings[f"{k}_set"] = "1" if (settings.pop(k, "") or "").strip() else "0"
    settings["auth_status"] = dict(auth_status)
    return JSONResponse({"settings": settings})


@app.post("/api/settings")
async def api_update_settings(request: Request):
    form = await request.form()
    updates = dict(form)
    for k in SECRET_SETTINGS:
        if k in updates and not str(updates[k]).strip():
            updates.pop(k)
    updates.pop("auth_status", None)
    for k in list(updates):
        if k.endswith("_set"):
            updates.pop(k)
    if updates:
        await update_settings(updates)
    return JSONResponse({"ok": True})


@app.post("/api/watches/add")
async def api_add_watch(request: Request):
    form = await request.form()
    kind = (form.get("kind") or "tag").strip()
    value = (form.get("value") or "").strip()
    label = (form.get("label") or "").strip()
    if kind not in ("tag", "artist") or not value:
        return JSONResponse({"ok": False, "error": "kind (tag|artist) and value required"}, status_code=400)
    if kind == "artist" and not value.isdigit():
        return JSONResponse({"ok": False, "error": "artist watches take the pixiv USER ID (a number — it's in the artist page URL)"}, status_code=400)
    wid = await add_watch(kind, value, label)
    if wid:
        watches = await get_watches()
        w = next((x for x in watches if x["id"] == wid), None)
        if w:
            asyncio.create_task(worker.scrape_watch_now(w))
    return JSONResponse({"ok": True, "id": wid})


@app.post("/api/watches/remove")
async def api_remove_watch(request: Request):
    form = await request.form()
    wid = form.get("id")
    if not wid:
        return JSONResponse({"ok": False, "error": "id required"}, status_code=400)
    await remove_watch(int(wid))
    return JSONResponse({"ok": True})


@app.post("/api/watches/toggle")
async def api_toggle_watch(request: Request):
    form = await request.form()
    wid = form.get("id")
    if not wid:
        return JSONResponse({"ok": False, "error": "id required"}, status_code=400)
    await toggle_watch(int(wid), form.get("enabled", "1") == "1")
    return JSONResponse({"ok": True})


@app.post("/api/watches/scrape-now")
async def api_scrape_now(request: Request):
    form = await request.form()
    wid = form.get("id")
    if not wid:
        return JSONResponse({"ok": False, "error": "id required"}, status_code=400)
    w = next((x for x in await get_watches() if x["id"] == int(wid)), None)
    if not w:
        return JSONResponse({"ok": False, "error": "watch not found"}, status_code=404)
    asyncio.create_task(worker.scrape_watch_now(w))
    return JSONResponse({"ok": True})


@app.post("/api/worker/pause")
async def api_worker_pause(request: Request):
    form = await request.form()
    if form.get("action", "pause") == "pause":
        worker.pause()
    else:
        worker.resume()
    return JSONResponse({"ok": True, "paused": worker.paused})


@app.post("/api/retry-failed")
async def api_retry_failed():
    await retry_failed()
    return JSONResponse({"ok": True})


# ── media (pximg needs the Referer, so the browser can't load it directly) ───

_media_client: httpx.AsyncClient | None = None


def media_client() -> httpx.AsyncClient:
    """One pooled client for all pximg proxying. A client per request meant a
    new TLS connection (and a DNS lookup) per image — the pattern that let the
    rule34 addon trip the LAN resolver's per-client rate limit and take down
    CT152's DNS. keepalive_expiry outlives gaps between page loads."""
    global _media_client
    if _media_client is None or _media_client.is_closed:
        _media_client = httpx.AsyncClient(
            follow_redirects=True, timeout=httpx.Timeout(60.0, connect=10.0),
            headers=PXIMG_HEADERS,
            limits=httpx.Limits(max_connections=16, max_keepalive_connections=8,
                                keepalive_expiry=60.0))
    return _media_client


async def _proxy_stream(url: str):
    client = media_client()
    try:
        req = client.build_request("GET", url)
        resp = await client.send(req, stream=True)
        if resp.status_code >= 400:
            # Read the small error body: closing an unread streamed response
            # makes httpx drop the connection instead of pooling it.
            await resp.aread()
            await resp.aclose()
            return None
    except Exception:
        return None

    async def body():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()

    return StreamingResponse(body(), media_type=resp.headers.get("content-type", "image/jpeg"))


@app.get("/media/thumb/{illust_id}")
async def media_thumb(illust_id: int):
    il = await get_illust(illust_id)
    if not il or not il["pages"]:
        return Response(status_code=404)
    pg = il["pages"][0]
    storage = await get_setting("storage_path") or ""
    if pg.get("downloaded") == 1 and pg.get("local_path"):
        full = os.path.join(storage, pg["local_path"])
        if os.path.isfile(full):
            return FileResponse(full)
    url = pg.get("preview_url") or pg.get("url")
    if not url:
        return Response(status_code=404)
    r = await _proxy_stream(url)
    return r if r else Response(status_code=502)


@app.get("/media/full/{illust_id}/{page_no}")
async def media_full(illust_id: int, page_no: int):
    il = await get_illust(illust_id)
    if not il:
        return Response(status_code=404)
    pg = next((p for p in il["pages"] if p["page_no"] == page_no), None)
    if not pg:
        return Response(status_code=404)
    storage = await get_setting("storage_path") or ""
    if pg.get("downloaded") == 1 and pg.get("local_path"):
        full = os.path.join(storage, pg["local_path"])
        if os.path.isfile(full) and os.path.getsize(full) > 0:
            return FileResponse(full)
    r = await _proxy_stream(pg["url"])
    return r if r else Response(status_code=502)
