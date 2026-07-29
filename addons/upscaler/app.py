"""FastAPI app + HTMX UI."""
import asyncio
import logging
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import config
import db
import dispatcher
import proxlab
import sync
from immich import Immich
from worker import Worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

immich: Immich | None = None
worker: Worker | None = None
sync_worker: sync.SyncWorker | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global immich, worker, sync_worker
    db.init()
    sync.init()
    config.WORK_DIR.mkdir(parents=True, exist_ok=True)
    immich = Immich()
    worker = Worker(immich)
    await worker.start()
    sync_worker = sync.SyncWorker(immich)
    await sync_worker.start()
    log.info(f"app started; Immich={config.IMMICH_URL}")
    try:
        yield
    finally:
        if sync_worker:
            await sync_worker.stop()
        if worker:
            await worker.stop()
        if immich:
            await immich.close()


app = FastAPI(lifespan=lifespan, title="Upscale Companion")
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(config.TEMPLATES_DIR))


def _ctx_settings() -> dict:
    return db.all_settings()


def _wants_json(request: Request) -> bool:
    """The native AI-Lab UI (Addons tab) requests JSON from the same routes the
    Jinja pages serve, via ?format=json or an Accept: application/json header."""
    if request.query_params.get("format") == "json":
        return True
    return "application/json" in request.headers.get("accept", "")


# ---- Pages ----

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    s = _ctx_settings()
    q = db.queue_summary()
    p = db.processed_summary()
    activity = db.recent_activity(20)
    watch = db.list_sources("watch")
    exclude = db.list_sources("exclude")
    immich_ok = True
    immich_err = None
    # Albums + tags for the inline source-add picker.
    try:
        albums = sorted(await immich.list_albums(),
                        key=lambda a: (a.get("albumName") or "").lower())
        tags = sorted(await immich.list_tags(),
                      key=lambda t: (t.get("value") or t.get("name") or "").lower())
    except Exception:
        albums, tags = [], []
    try:
        ver = await immich.server_version()
        immich_version = f"v{ver['major']}.{ver['minor']}.{ver['patch']}"
    except Exception as e:
        immich_ok = False
        immich_err = str(e)
        immich_version = "?"
    # GPU inventory + selections. If the DB cache is empty, attempt a live refresh
    # from proxlab so the user sees something on first page load.
    gpus = db.list_all_gpus()
    if not gpus:
        try:
            await proxlab.refresh_inventory()
            gpus = db.list_all_gpus()
        except Exception as e:
            log.warning(f"index: proxlab refresh failed: {e}")
    # Group by container for cleaner rendering
    gpus_by_container = {}
    for g in gpus:
        gpus_by_container.setdefault(g["container_name"] or g["agent_name"], []).append(g)
    enabled_count = sum(1 for g in gpus if g["enabled"])
    ctx = {
        "settings": s,
        "queue": q,
        "processed": p,
        "activity": activity,
        "processing": db.list_processing(),
        "now_ts": int(__import__('time').time()),
        "watch": watch,
        "exclude": exclude,
        "immich_ok": immich_ok,
        "immich_err": immich_err,
        "immich_version": immich_version,
        "immich_url": config.IMMICH_URL,
        "albums": albums,
        "tags": tags,
        "job_depth": {},
        "gpus_by_container": gpus_by_container,
        "enabled_gpu_count": enabled_count,
    }
    if _wants_json(request):
        return JSONResponse(ctx)
    return templates.TemplateResponse(request, "index.html", ctx)


PAGE_SIZE_OPTIONS = [25, 50, 100, 250]

# In-memory cache of asset lists per source signature. TTL 5 min.
# Browse view uses SHALLOW caches (direct-tagged or album), which are fast.
# The "Queue all (incl children)" button uses the DEEP cache (per-tag fan-out)
# only on click -- so the slow operation is gated on explicit user action.
_asset_cache_shallow: dict[tuple, tuple[float, list[dict]]] = {}
_asset_cache_deep: dict[tuple, tuple[float, list[dict]]] = {}
_CACHE_TTL = 300


async def _get_assets_shallow(album_id: str | None, tag_id: str | None,
                              with_stacked: bool = False) -> list[dict]:
    """Fast: album direct or tag direct (no child expansion). Used by browse view.

    `with_stacked=True` surfaces assets that are members of a stack (i.e. already
    upscaled). Browse leaves it False so already-done assets stay hidden; the
    history filter sets it True so an already-upscaled album/tag isn't empty —
    Immich's metadata search hides the whole stack otherwise."""
    import time
    if album_id:
        key = ("album", album_id, with_stacked)
    elif tag_id:
        key = ("tag", tag_id, with_stacked)
    else:
        return []
    now = time.time()
    hit = _asset_cache_shallow.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    if album_id:
        assets = await immich.list_all_matching_assets(album_ids=[album_id], with_stacked=with_stacked)
    else:
        assets = await immich.list_all_matching_assets(tag_ids=[tag_id], with_stacked=with_stacked)
    _asset_cache_shallow[key] = (now, assets)
    return assets


async def _get_assets_deep_for_tag(tag_id: str, with_stacked: bool = False) -> list[dict]:
    """Slow: tag + all descendants via per-tag fan-out. Used only on 'queue all'.

    See _get_assets_shallow for the with_stacked rationale."""
    import time
    key = ("tag", tag_id, with_stacked)
    now = time.time()
    hit = _asset_cache_deep.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    expanded = await immich.expand_tag(tag_id)
    assets = await immich.list_all_matching_assets(tag_ids=expanded, with_stacked=with_stacked)
    _asset_cache_deep[key] = (now, assets)
    return assets


def _windowed_page_list(current: int, last: int, around: int = 2) -> list:
    """Returns a windowed page list with ellipses, e.g. [1, '...', 4, 5, 6, '...', 23]."""
    if last <= 1:
        return [1]
    pages = set([1, last, current])
    for d in range(-around, around + 1):
        p = current + d
        if 1 <= p <= last:
            pages.add(p)
    sorted_pages = sorted(pages)
    out = []
    prev = None
    for p in sorted_pages:
        if prev is not None and p - prev > 1:
            out.append("...")
        out.append(p)
        prev = p
    return out


@app.get("/browse", response_class=HTMLResponse)
async def browse(request: Request, album_id: str | None = None, tag_id: str | None = None,
                 page: int = 1, page_size: str = "50"):
    albums = await immich.list_albums()
    tags = await immich.list_tags()

    # Resolve effective page_size (special "all" sentinel)
    show_all = (page_size == "all")
    try:
        ps = int(page_size) if not show_all else 0
    except ValueError:
        ps = 50

    page_assets: list[dict] = []
    total = 0
    total_pages = 1
    page_list: list = []
    expanded_tag_ids: list[str] = []
    if tag_id:
        try:
            expanded_tag_ids = await immich.expand_tag(tag_id, all_tags=tags)
        except Exception:
            expanded_tag_ids = [tag_id]

    # For albums, total is known up-front via assetCount.
    known_total: int | None = None
    if album_id:
        for a in albums:
            if a.get("id") == album_id:
                known_total = a.get("assetCount")
                break

    if album_id or tag_id:
        # Direct Immich pagination: ONE call per page. Fast.
        # Real total is unknown until we hit the last page; we surface
        # "more available" as a hint when nextPage exists.
        req_size = 1000 if show_all else ps
        req_page = 1 if show_all else max(1, page)
        try:
            res = await immich.search_metadata(
                tag_ids=[tag_id] if tag_id else None,
                album_ids=[album_id] if album_id else None,
                page=req_page, size=req_size, with_exif=True,
            )
            page_assets = res.get("items") or []
            np = res.get("nextPage")
            if show_all:
                # Drain everything
                while np:
                    try:
                        res = await immich.search_metadata(
                            tag_ids=[tag_id] if tag_id else None,
                            album_ids=[album_id] if album_id else None,
                            page=int(np), size=req_size, with_exif=True,
                        )
                    except Exception:
                        break
                    page_assets.extend(res.get("items") or [])
                    np = res.get("nextPage")
                total = len(page_assets)
                total_pages = 1
                page = 1
                has_more = False
            else:
                has_more = bool(np)
                if known_total is not None:
                    # We knew up-front (album) — exact total + numbered pagination
                    total = known_total
                    total_pages = max(1, (total + ps - 1) // ps)
                elif not has_more:
                    # We hit the last page — real total = (page-1)*ps + assets-on-this-page
                    total = (page - 1) * ps + len(page_assets)
                    total_pages = page
                else:
                    # Total unknown mid-stream. Show "more available".
                    total = page * ps
                    total_pages = page + 1
        except Exception as e:
            log.warning(f"page fetch failed: {e}")
            page_assets = []
            has_more = False
        # Show numbered page list when total is known (exact + windowed).
        # When known_total is set, we know all pages even on intermediate ones.
        if show_all:
            page_list = []
        elif known_total is not None or not has_more:
            page_list = _windowed_page_list(page, total_pages)
        else:
            page_list = []

    ctx = {
        "albums": sorted(albums, key=lambda a: (a.get("albumName") or "").lower()),
        "tags": sorted(tags, key=lambda t: (t.get("value") or t.get("name") or "").lower()),
        "selected_album": album_id,
        "selected_tag": tag_id,
        "expanded_tag_count": len(expanded_tag_ids),
        "assets": page_assets,
        "total": total,
        "page": page,
        "total_pages": total_pages,
        "page_list": page_list,
        "page_size_str": page_size,
        "show_all": show_all,
        "page_size_options": PAGE_SIZE_OPTIONS,
        "has_more": locals().get("has_more", False),
    }
    if _wants_json(request):
        return JSONResponse(ctx)
    return templates.TemplateResponse(request, "browse.html", ctx)


# ---- HTMX partials ----

@app.get("/_/status", response_class=HTMLResponse)
async def htmx_status(request: Request):
    q = db.queue_summary()
    p = db.processed_summary()
    activity = db.recent_activity(20)
    job_depth = {}
    if immich:
        try:
            job_depth = await immich.job_queue_depth()
        except Exception:
            pass
    return templates.TemplateResponse(request, "components/status.html", {
        "queue": q,
        "processed": p,
        "activity": activity,
        "processing": db.list_processing(),
        "now_ts": int(__import__('time').time()),
        "settings": _ctx_settings(),
        "job_depth": job_depth,
        "enabled_gpu_count": sum(1 for g in db.list_all_gpus() if g["enabled"]),
    })


# ---- Source management ----

@app.post("/api/sources/add")
async def add_source(kind: str = Form(), external_id: str = Form(),
                     name: str = Form(), role: str = Form()):
    if kind not in ("tag", "album") or role not in ("watch", "exclude"):
        raise HTTPException(400, "bad kind/role")
    db.add_source(kind, external_id, name, role)
    return {"ok": True}


@app.post("/api/sources/{source_id}/delete")
async def del_source(source_id: int):
    db.remove_source(source_id)
    return {"ok": True}


# ---- Settings ----

@app.post("/api/settings")
async def save_settings(request: Request):
    form = await request.form()
    # Whitelist what users can change via the form
    allowed = {"model", "proxlab_url", "gpu_host_user", "gpu_host_script",
               "min_input_mp", "poll_interval_sec",
               "worker_enabled", "auto_managed_tag"}
    for k, v in form.items():
        if k in allowed:
            db.set_setting(k, str(v))
    return {"ok": True}


# ---- Worker controls ----

@app.post("/api/worker/pause")
async def worker_pause():
    db.set_setting("worker_enabled", "0")
    return {"ok": True}


@app.post("/api/worker/resume")
async def worker_resume():
    db.set_setting("worker_enabled", "1")
    return {"ok": True}


@app.post("/api/poll-now")
async def poll_now():
    if worker:
        # Force a poll on next worker tick by zeroing last_poll inside the loop:
        # easiest just to schedule it directly
        asyncio.create_task(worker._poll_immich())
    return {"ok": True}


# ---- Manual queue ----

@app.post("/api/queue")
async def manual_queue(request: Request):
    form = await request.form()
    asset_ids = form.getlist("asset_id")
    n = 0
    for aid in asset_ids:
        if db.enqueue(aid, "manual"):
            n += 1
    return {"ok": True, "queued": n}


@app.post("/api/queue/all")
async def queue_all(request: Request):
    """Enqueue every asset matching a source.
    For tags: `include_children=1` triggers slow per-tag fan-out across descendants.
    Without it, only direct-tagged assets are queued.
    """
    form = await request.form()
    album_id = (form.get("album_id") or "") or None
    tag_id = (form.get("tag_id") or "") or None
    include_children = form.get("include_children") == "1"
    if not album_id and not tag_id:
        raise HTTPException(400, "album_id or tag_id required")
    if tag_id and include_children:
        assets = await _get_assets_deep_for_tag(tag_id)
    else:
        assets = await _get_assets_shallow(album_id, tag_id)
    ref = f"album:{album_id}" if album_id else f"tag:{tag_id}"
    if include_children: ref += "+children"
    n = 0
    for a in assets:
        aid = a.get("id")
        if aid and db.enqueue(aid, ref):
            n += 1
    log.info(f"queue-all {ref}: {n} new of {len(assets)} matching")
    return {"ok": True, "queued": n, "matching": len(assets)}


@app.post("/api/queue/{asset_id}/retry")
async def retry(asset_id: str):
    db.retry_failed(asset_id)
    return {"ok": True}


# ---- History + compare viewer ----

HISTORY_PAGE_SIZE = 50
HISTORY_PAGE_SIZE_OPTIONS = ["50", "100", "250", "500", "1000", "ALL"]


@app.get("/history", response_class=HTMLResponse)
async def history(request: Request, page: int = 1, status: str = "ok",
                  album_id: str | None = None, tag_id: str | None = None,
                  include_children: int = 0, page_size: str | None = None):
    if status not in ("ok", "failed"):
        status = "ok"

    # Resolve the persistent "entries per page" preference. If the request
    # carries a valid page_size, adopt it and persist; otherwise use the stored
    # value (default 50). "ALL" shows everything on a single page.
    if page_size in HISTORY_PAGE_SIZE_OPTIONS:
        db.set_setting("history_page_size", page_size)
        selected_page_size = page_size
    else:
        selected_page_size = db.get_setting("history_page_size", "50")
        if selected_page_size not in HISTORY_PAGE_SIZE_OPTIONS:
            selected_page_size = "50"
    if selected_page_size == "ALL":
        page = 1
        eff_limit = 1_000_000_000
    else:
        eff_limit = int(selected_page_size)

    # Always pull album/tag lists for the picker (cheap, cached upstream).
    albums = await immich.list_albums()
    tags = await immich.list_tags()

    # When a filter is selected, scope rows to assets matching that source.
    filter_active = bool(album_id or tag_id)
    filter_label = ""
    filter_asset_ids: set[str] = set()
    if filter_active:
        # with_stacked=True: history is filtering over ALREADY-upscaled assets,
        # which live inside stacks that Immich's metadata search hides by default.
        if tag_id and include_children:
            matching = await _get_assets_deep_for_tag(tag_id, with_stacked=True)
        else:
            matching = await _get_assets_shallow(album_id, tag_id, with_stacked=True)
        filter_asset_ids = {a["id"] for a in matching if a.get("id")}
        if album_id:
            name = next((a.get("albumName", "?") for a in albums if a.get("id") == album_id), "?")
            filter_label = f"album: {name}"
        elif tag_id:
            name = next((t.get("value") or t.get("name", "?") for t in tags if t.get("id") == tag_id), "?")
            filter_label = f"tag: {name}" + (" (incl. children)" if include_children else "")

    # Get the page slice + total for the current view (filter-aware).
    if filter_active:
        entries, total = db.list_processed_filtered(
            asset_id_set=filter_asset_ids, status=status,
            limit=eff_limit, offset=(page - 1) * eff_limit,
        )
        # Filter-aware tab counters
        _ok_rows, ok_count = db.list_processed_filtered(filter_asset_ids, "ok", limit=999999, offset=0)
        _f_rows, failed_count = db.list_processed_filtered(filter_asset_ids, "failed", limit=999999, offset=0)
    else:
        total = db.count_processed(status=status)
        entries = db.list_processed(limit=eff_limit,
                                    offset=(page - 1) * eff_limit,
                                    status=status)
        ok_count = db.count_processed(status="ok")
        failed_count = db.count_failed()

    total_pages = max(1, (total + eff_limit - 1) // eff_limit)
    page = max(1, min(page, total_pages))
    page_list = _windowed_page_list(page, total_pages)
    ctx = {
        "entries": entries,
        "total": total,
        "page": page,
        "total_pages": total_pages,
        "page_list": page_list,
        "view": status,
        "ok_count": ok_count,
        "failed_count": failed_count,
        # Filter UI state
        "albums": albums,
        "tags": tags,
        "selected_album": album_id or "",
        "selected_tag": tag_id or "",
        "include_children": bool(include_children),
        "filter_active": filter_active,
        "filter_label": filter_label,
        # Page-size preference
        "selected_page_size": selected_page_size,
        "page_size_options": HISTORY_PAGE_SIZE_OPTIONS,
    }
    if _wants_json(request):
        return JSONResponse(ctx)
    return templates.TemplateResponse(request, "history.html", ctx)


@app.post("/api/history/{asset_id}/reprocess")
async def history_reprocess_one(asset_id: str, view: str = "ok"):
    """Clear processed (ok OR failed) + re-enqueue. Worker will use the
    current active model setting — change the model first if you want a
    re-run with a different upscaler. Same endpoint covers 'retry failed'
    and 'reprocess succeeded' since the underlying action is identical."""
    db.reprocess_one(asset_id, source_ref="reprocess")
    return {"ok": True}


@app.post("/api/history/reprocess-batch")
async def history_reprocess_batch(request: Request):
    """Bulk retry/reprocess. Form body sources, in priority order:
      1. `all_in_filter=1` + album_id/tag_id/include_children → every row of
         the current `view` whose asset is in the filtered album/tag
      2. `all_failed=1` → every failed asset (ignores any filter, kept for
         the unfiltered failures view)
      3. Explicit `asset_id[]` entries from the checkbox bulk-action bar"""
    form = await request.form()
    view = form.get("view", "ok")
    album_id = (form.get("album_id") or "") or None
    tag_id = (form.get("tag_id") or "") or None
    include_children = form.get("include_children") == "1"
    all_in_filter = form.get("all_in_filter") == "1"
    all_failed = form.get("all_failed") == "1"
    asset_ids = list(form.getlist("asset_id"))

    if all_in_filter and (album_id or tag_id):
        # with_stacked=True to match the (already-upscaled) assets the history
        # view shows — see _get_assets_shallow.
        if tag_id and include_children:
            matching = await _get_assets_deep_for_tag(tag_id, with_stacked=True)
        else:
            matching = await _get_assets_shallow(album_id, tag_id, with_stacked=True)
        filter_set = {a["id"] for a in matching if a.get("id")}
        # Pull the rows already in `view` status that fall in the filter
        rows, _ = db.list_processed_filtered(filter_set, view, limit=999999, offset=0)
        asset_ids = [r["asset_id"] for r in rows]
    elif all_failed:
        asset_ids = db.list_failed_asset_ids()

    n = db.reprocess_batch(asset_ids, source_ref="reprocess")
    log.info(f"history reprocess-batch: {n} asset(s) re-enqueued (view={view}, "
             f"filter={'album:'+album_id if album_id else 'tag:'+tag_id if tag_id else 'none'})")
    return {"ok": True, "reprocessed": n}


@app.get("/compare/{asset_id}", response_class=HTMLResponse)
async def compare(request: Request, asset_id: str):
    entry = db.get_processed(asset_id)
    if not entry or entry.get("status") != "ok":
        raise HTTPException(404, "no processed entry for that asset")
    if not entry.get("new_asset_id"):
        raise HTTPException(404, "this entry has no upscaled version (legacy?)")
    if _wants_json(request):
        return JSONResponse({"entry": entry})
    return templates.TemplateResponse(request, "compare.html", {"entry": entry})


@app.get("/preview/{asset_id}")
async def preview(asset_id: str, which: str = "original", size: str = "preview"):
    """Proxy Immich asset bytes through the companion (browser has no API key).
    Streams to keep memory bounded. For which=thumbnail, `size` selects the
    Immich rendition: 'thumbnail' (small, ~tens of KB — use for list thumbs)
    or 'preview' (large, ~MB — use for the comparison viewer)."""
    from fastapi.responses import StreamingResponse
    if which == "thumbnail":
        sz = size if size in ("thumbnail", "preview") else "preview"
        url = f"/api/assets/{asset_id}/thumbnail?size={sz}"
    else:
        url = f"/api/assets/{asset_id}/original"
    req = immich.client.build_request("GET", url)
    upstream = await immich.client.send(req, stream=True)
    if upstream.status_code != 200:
        body = await upstream.aread()
        await upstream.aclose()
        raise HTTPException(upstream.status_code,
                            body.decode("utf-8", "replace")[:500])
    media = upstream.headers.get("content-type", "application/octet-stream")
    async def streamer():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=1024 * 256):
                yield chunk
        finally:
            await upstream.aclose()
    return StreamingResponse(streamer(), media_type=media,
                              headers={"cache-control": "private, max-age=86400"})


# ---- GPU selection ----

@app.post("/api/gpus/refresh")
async def gpus_refresh():
    """Force a fresh fetch from proxlab."""
    n = await proxlab.refresh_inventory()
    log.info(f"manual GPU refresh: {n} GPUs cached")
    return {"ok": True}


@app.post("/api/gpus/save")
async def gpus_save(request: Request):
    """Form post: a list of `enabled` field values shaped agent_name:cuda_index.
    Anything in that list becomes enabled; everything else disabled.
    """
    form = await request.form()
    keys = form.getlist("enabled")
    selections = {}
    for k in keys:
        if ":" not in k:
            continue
        agent, idx = k.rsplit(":", 1)
        try:
            selections[(agent, int(idx))] = True
        except ValueError:
            continue
    db.set_gpu_selections_bulk(selections)
    log.info(f"saved {len(selections)} GPU selection(s)")
    return {"ok": True}


# ============================ tag sync (download) ============================

def _build_tag_tree(sw, root_id):
    """Nested {id,value,leaf,count,children} rooted at root_id, with per-tag
    downloaded counts. Uses the (already-refreshed) sw._tag_index."""
    idx = sw._tag_index
    def node(tid):
        t = idx.get(tid, {})
        val = t.get("value") or t.get("name") or tid
        kids = sorted(sw._children_of(tid),
                      key=lambda k: (idx.get(k, {}).get("value") or "").lower())
        return {
            "id": tid,
            "value": val,
            "leaf": val.rsplit("/", 1)[-1],
            "count": sync.count_synced(tid),
            "children": [node(k) for k in kids],
        }
    return node(root_id)


@app.get("/sync", response_class=HTMLResponse)
async def sync_page(request: Request, q: str = ""):
    try:
        tags = sorted(await immich.list_tags(),
                      key=lambda t: (t.get("value") or t.get("name") or "").lower())
    except Exception:
        tags = []
    src_ids = {s["tag_id"] for s in sync.list_sources()}
    if sync_worker:
        try:
            await sync_worker.refresh_tag_index()
        except Exception:
            pass
    trees = []
    for s in sync.list_sources():
        if sync_worker and s["tag_id"] in sync_worker._tag_index:
            tree = _build_tag_tree(sync_worker, s["tag_id"])
        else:
            tree = {"id": s["tag_id"], "value": s["tag_value"],
                    "leaf": s["tag_value"], "count": sync.count_synced(s["tag_id"]),
                    "children": []}
        def _sum(n): return n["count"] + sum(_sum(c) for c in n["children"])
        def _cnt(n): return 1 + sum(_cnt(c) for c in n["children"])
        trees.append({"src": s, "tree": tree,
                      "total_synced": _sum(tree), "n_tags": _cnt(tree)})
    filtered = tags
    if q:
        ql = q.lower()
        filtered = [t for t in tags if ql in (t.get("value") or t.get("name") or "").lower()]
    ctx = {
        "tags": filtered,
        "tag_total": len(tags),
        "src_ids": list(src_ids),
        "trees": trees,
        "enabled": db.get_setting("sync_enabled", "1") == "1",
        "dest_root": db.get_setting("sync_dest_root",
                                    "/mnt/flashpool/ai-assets/imagegen/training_images"),
        "interval": int(db.get_setting("sync_poll_interval_sec", "300") or 300),
        "q": q,
    }
    if _wants_json(request):
        return JSONResponse(ctx)
    return templates.TemplateResponse(request, "sync.html", ctx)


@app.get("/api/sync/status")
async def sync_status():
    p = dict(getattr(sync_worker, "progress", {})) if sync_worker else {}
    p["last_run"] = getattr(sync_worker, "last_run", 0) or 0
    p["enabled"] = db.get_setting("sync_enabled", "1") == "1"
    return p


@app.post("/api/sync/source")
async def sync_source(tag_id: str = Form(...), action: str = Form("add")):
    if action == "remove":
        sync.remove_source(tag_id)
    else:
        val = tag_id
        try:
            for t in await immich.list_tags():
                if t.get("id") == tag_id:
                    val = t.get("value") or t.get("name") or tag_id
                    break
        except Exception:
            pass
        sync.add_source(tag_id, val)
    return {"ok": True}


@app.post("/api/sync/reset")
async def sync_reset(tag_id: str = Form(...)):
    eff = [tag_id]
    if sync_worker:
        try:
            await sync_worker.refresh_tag_index()
            eff = sync_worker.effective_tags(tag_id)
        except Exception:
            pass
    n = sync.reset_source(eff)
    log.info(f"sync reset: cleared {n} ledger row(s) for {tag_id[:8]} (+{len(eff)-1} descendants)")
    return {"ok": True}


@app.post("/api/sync/run")
async def sync_run():
    if sync_worker:
        sync_worker.trigger()   # single-flight: no-op if a pass is already running
    return {"ok": True}


@app.post("/api/upscale-file")
async def upscale_file(request: Request):
    """Ad-hoc upscale of ONE file living under the shared training_images mount
    (used by ProxLab's training-set "re-upscale" button). Picks a free GPU,
    runs the same SeedVR2 pipeline, and drops the result in a temp dir on the
    shared mount for the caller to swap in. Synchronous (server-to-server)."""
    body = await request.json()
    rel = (body.get("path") or "").lstrip("/")
    root = Path(db.get_setting("sync_local_dest", "/training_images")).resolve()
    src = (root / rel).resolve()
    try:
        src.relative_to(root)
    except ValueError:
        raise HTTPException(400, "path escapes training_images root")
    if not src.is_file():
        raise HTTPException(404, "no such file")
    if worker is None:
        raise HTTPException(503, "worker not ready")
    gpu = worker.acquire_gpu()
    if not gpu:
        raise HTTPException(503, "no free GPU available — try again shortly")
    uid = "tsup-" + uuid.uuid4().hex[:12]
    try:
        model = (body.get("model") or db.get_setting("model", "seedvr2-7b-fp8")).strip()
        local_result, logx = await dispatcher.upscale_asset(
            uid, src, model, gpu["agent_ip"], gpu["cuda_index"])
        if not local_result or not Path(local_result).is_file():
            raise HTTPException(500, f"upscale failed: {logx}")
        tmp_dir = root / ".upscale_tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        out_rel = f".upscale_tmp/{uid}{Path(local_result).suffix}"
        shutil.copyfile(local_result, root / out_rel)
        try:
            (root / out_rel).chmod(0o664)
        except Exception:
            pass
        return {"ok": True, "out": out_rel, "gpu": gpu.get("friendly_name"), "log": logx}
    finally:
        worker.release_gpu(gpu)
        shutil.rmtree(config.WORK_DIR / uid, ignore_errors=True)


@app.post("/api/sync/toggle")
async def sync_toggle():
    cur = db.get_setting("sync_enabled", "1") == "1"
    db.set_setting("sync_enabled", "0" if cur else "1")
    return {"ok": True}
