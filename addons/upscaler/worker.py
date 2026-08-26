"""Background polling + dispatch loop. Runs inside the FastAPI process via asyncio."""
import asyncio
import logging
import shutil
import time
from pathlib import Path
import db
import proxlab
from config import WORK_DIR
from immich import Immich
import dispatcher

log = logging.getLogger(__name__)


class Worker:
    def __init__(self, immich: Immich):
        self.immich = immich
        self.task: asyncio.Task | None = None
        self.upscaled_tag_id: str | None = None
        self.highres_tag_id: str | None = None
        self._stop = False
        # In-flight GPU tracking: set of (agent_name, cuda_index) currently in use.
        self._in_flight_gpus: set[tuple[str, int]] = set()
        self._inv_refresh_at = 0.0

    async def start(self):
        if self.task and not self.task.done():
            return
        self._stop = False
        self.task = asyncio.create_task(self._loop(), name="upscale-worker")

    async def stop(self):
        self._stop = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    def acquire_gpu(self) -> dict | None:
        """Reserve a free enabled GPU for an ad-hoc (non-queue) job. Shares the
        worker's in-flight set so batch dispatch and ad-hoc upscales never pick
        the same GPU. Caller MUST release_gpu() when done."""
        for g in db.list_enabled_gpus():
            key = (g["agent_name"], g["cuda_index"])
            if key not in self._in_flight_gpus:
                self._in_flight_gpus.add(key)
                return g
        return None

    def release_gpu(self, g: dict):
        self._in_flight_gpus.discard((g["agent_name"], g["cuda_index"]))

    async def _loop(self):
        log.info("worker loop starting")
        # Recover from a crash/restart: any row still in 'processing' state
        # is a zombie (in-memory in_flight tracking was lost). Reset to pending.
        n_recovered = db.reset_stale_processing(0)
        if n_recovered:
            log.warning(f"startup recovery: reset {n_recovered} stale 'processing' row(s) back to pending")
        try:
            await self._ensure_upscaled_tag()
        except Exception as e:
            log.error(f"failed to ensure auto-managed tag: {e}")
        last_poll = 0.0
        last_stuck_check = 0.0
        while not self._stop:
            if db.get_setting("worker_enabled", "1") != "1":
                await asyncio.sleep(5)
                continue
            interval = int(db.get_setting("poll_interval_sec", "60") or 60)
            try:
                now = time.time()
                # Refresh GPU inventory from proxlab periodically (every 60s)
                if now - self._inv_refresh_at >= 60:
                    try:
                        n = await proxlab.refresh_inventory()
                        if n:
                            self._inv_refresh_at = now
                    except Exception as e:
                        log.warning(f"GPU inventory refresh failed: {e}")
                # Detect stuck rows every 5 min: anything 'processing' for
                # >30 min that the worker hasn't touched is a hang or orphan.
                # Only reset rows NOT tracked in our in_flight set (so we
                # don't yank a legitimately-long job from under itself).
                if now - last_stuck_check >= 300:
                    last_stuck_check = now
                    try:
                        from db import list_processing
                        for r in list_processing():
                            key = (r.get("agent_name"), r.get("cuda_index"))
                            sa = r.get("started_at") or now
                            if (key not in self._in_flight_gpus
                                    and now - sa > 1800):
                                rc = db.reset_stale_processing(1800)
                                if rc:
                                    log.warning(f"stuck-check: reset {rc} orphan processing row(s) (>30min, not tracked in memory)")
                                break  # one reset call handles them all
                    except Exception as e:
                        log.warning(f"stuck-check failed: {e}")
                if now - last_poll >= interval:
                    await self._poll_immich()
                    last_poll = now
                await self._drain_queue()
            except Exception as e:
                log.exception(f"worker iteration failed: {e}")
            await asyncio.sleep(5)
        log.info("worker loop stopped")

    async def _ensure_upscaled_tag(self):
        name = db.get_setting("auto_managed_tag", "upscaled")
        tag = await self.immich.upsert_tag(name)
        self.upscaled_tag_id = tag["id"]
        log.info(f"auto-managed tag '{name}' id={self.upscaled_tag_id}")
        # 'already at/above the MP cutoff' marker so these native-res images are
        # still recognized as training-ready by the sync downloader (which pulls
        # upscaled OR highres). Tagged during poll instead of being silently skipped.
        hname = db.get_setting("highres_tag", "upscale-res")
        try:
            htag = await self.immich.upsert_tag(hname)
            self.highres_tag_id = htag["id"]
            log.info(f"highres tag '{hname}' id={self.highres_tag_id}")
        except Exception as e:
            log.warning(f"failed to ensure highres tag '{hname}': {e}")
        # Local record of assets we've already upscale-res-tagged. Immich's
        # /search/metadata does NOT return per-asset tags, so the tag-based
        # exclude can't see them; without this we'd re-tag the same set every poll.
        with db.conn() as c:
            c.execute("CREATE TABLE IF NOT EXISTS highres_tagged "
                      "(asset_id TEXT PRIMARY KEY, tagged_at REAL)")

    def _highres_marked(self) -> set:
        with db.conn() as c:
            return {r[0] for r in c.execute("SELECT asset_id FROM highres_tagged").fetchall()}

    def _mark_highres(self, asset_ids: list):
        import time as _t
        now = _t.time()
        with db.conn() as c:
            c.executemany("INSERT OR IGNORE INTO highres_tagged (asset_id, tagged_at) "
                          "VALUES (?,?)", [(a, now) for a in asset_ids])

    async def _poll_immich(self):
        sources_watch = db.list_sources("watch")
        sources_exclude = db.list_sources("exclude")
        if not sources_watch:
            return
        tag_ids = [s["external_id"] for s in sources_watch if s["kind"] == "tag"]
        album_ids = [s["external_id"] for s in sources_watch if s["kind"] == "album"]
        exclude_tag_ids = {s["external_id"] for s in sources_exclude if s["kind"] == "tag"}
        exclude_album_ids = {s["external_id"] for s in sources_exclude if s["kind"] == "album"}
        # Always exclude assets already handled: upscaled (got a hi-res copy) or
        # tagged upscale-res (native res, no upscale needed). Both are terminal.
        if self.upscaled_tag_id:
            exclude_tag_ids.add(self.upscaled_tag_id)
        if self.highres_tag_id:
            exclude_tag_ids.add(self.highres_tag_id)

        found = []
        # Expand each watch tag to itself + all descendants. Immich's tagIds[]
        # is AND-semantics, so OR across N tags requires N searches (per-tag).
        # We cache the expanded list briefly so repeated polls aren't expensive.
        all_tags = None
        for tid in tag_ids:
            try:
                if all_tags is None:
                    all_tags = await self.immich.list_tags()
                expanded = await self.immich.expand_tag(tid, all_tags=all_tags)
            except Exception as e:
                log.warning(f"expand_tag({tid}) failed: {e}")
                expanded = [tid]
            for sub_tid in expanded:
                async for asset in self._paginate_search(tag_ids=[sub_tid]):
                    if self._asset_excluded(asset, exclude_tag_ids, exclude_album_ids):
                        continue
                    found.append((asset, f"tag:{tid}"))
        for aid in album_ids:
            async for asset in self._paginate_search(album_ids=[aid]):
                if self._asset_excluded(asset, exclude_tag_ids, exclude_album_ids):
                    continue
                found.append((asset, f"album:{aid}"))
        # Dedup by id (asset may match multiple watch sources)
        seen = set()
        enqueued = 0
        highres_to_tag = []
        already_highres = self._highres_marked()
        min_mp = float(db.get_setting("min_input_mp", "4.2") or 4.2)
        for asset, ref in found:
            aid = asset["id"]
            if aid in seen:
                continue
            seen.add(aid)
            # Already at/above the MP gate -> no upscale needed, but it IS a valid
            # training image, so tag it upscale-res (the sync downloader pulls it).
            w = asset.get("exifInfo", {}).get("exifImageWidth") or 0
            h = asset.get("exifInfo", {}).get("exifImageHeight") or 0
            if w and h and (w * h) / 1_000_000.0 >= min_mp:
                if self.highres_tag_id and aid not in already_highres:
                    highres_to_tag.append(aid)
                continue
            if db.enqueue(aid, ref):
                enqueued += 1
        # Batch-tag the native-res images ONCE (local record stops re-tagging,
        # since Immich search doesn't return tags for the exclude check).
        if highres_to_tag and self.highres_tag_id:
            try:
                await self.immich.tag_assets(self.highres_tag_id, highres_to_tag)
                self._mark_highres(highres_to_tag)
                log.info(f"poll: tagged {len(highres_to_tag)} native-res asset(s) upscale-res")
            except Exception as e:
                log.warning(f"poll: highres tagging failed: {e}")
        if enqueued:
            log.info(f"poll: enqueued {enqueued} new asset(s) (saw {len(seen)} matches)")

    async def _paginate_search(self, *, tag_ids: list[str] | None = None,
                                album_ids: list[str] | None = None):
        page = 1
        size = 250
        while True:
            res = await self.immich.search_metadata(
                tag_ids=tag_ids, album_ids=album_ids, page=page, size=size, with_exif=True,
            )
            items = res.get("items", []) or []
            for it in items:
                yield it
            np = res.get("nextPage")
            if not np:
                break
            try:
                page = int(np)
            except (TypeError, ValueError):
                break

    def _asset_excluded(self, asset: dict, ex_tags: set[str], ex_albums: set[str]) -> bool:
        for t in asset.get("tags") or []:
            if t.get("id") in ex_tags:
                return True
        # Note: asset.albums isn't always populated by /search/metadata. Exclusion-by-album
        # is best-effort; for hard exclusion the user should use a tag.
        return False

    async def _drain_queue(self):
        # Throttle on Immich job queue depth
        depths = await self.immich.job_queue_depth()
        sweat = depths.get("smartSearch", {}).get("waiting", 0) + \
                depths.get("metadataExtraction", {}).get("waiting", 0)
        if sweat > 50:
            log.info(f"backpressure: Immich job queue {sweat} waiting; pausing dispatch")
            return
        # Find which enabled GPUs are currently free.
        enabled = db.list_enabled_gpus()
        free_gpus = [
            g for g in enabled
            if (g["agent_name"], g["cuda_index"]) not in self._in_flight_gpus
            and g.get("agent_ip")
        ]
        if not free_gpus:
            return
        # Batch dispatch: each free GPU gets up to batch_size images in ONE
        # pipeline run (model loads once per batch, not per image). batch_size=1
        # reduces to the classic one-image-per-run behaviour.
        batch_size = max(1, int(db.get_setting("batch_size", "30") or 30))
        claimed = db.claim_pending(limit=len(free_gpus) * batch_size)
        if not claimed:
            return
        tasks = []
        idx = 0
        for gpu in free_gpus:
            chunk = claimed[idx:idx + batch_size]
            if not chunk:
                break
            idx += len(chunk)
            key = (gpu["agent_name"], gpu["cuda_index"])
            self._in_flight_gpus.add(key)
            tasks.append(self._process_batch(chunk, gpu))
        if tasks:
            await asyncio.gather(*tasks)

    async def _process_batch(self, qitems: list, gpu: dict):
        key = (gpu["agent_name"], gpu["cuda_index"])
        asset_ids = [q["asset_id"] for q in qitems]
        try:
            await self._do_batch(asset_ids, gpu)
        except Exception as e:
            log.exception(f"batch on {key} crashed: {e}")
            # Hard crash: re-queue the whole batch so nothing is lost.
            for a in asset_ids:
                self._requeue(a)
        finally:
            self._in_flight_gpus.discard(key)

    async def _prep_asset(self, asset_id: str, gpu: dict, dest_dir: Path):
        """Fetch metadata + download the original into dest_dir/<asset_id><ext>.
        Returns a meta dict, or None if prep failed (asset marked failed)."""
        try:
            info = await self.immich.asset_info(asset_id)
        except Exception as e:
            log.error(f"{asset_id}: asset_info failed: {e}")
            db.mark_failed(asset_id, f"asset_info failed: {e}")
            return None
        filename = info.get("originalFileName") or asset_id
        db.mark_dispatched(asset_id, gpu["agent_name"], gpu["cuda_index"], filename)
        parts = filename.rsplit(".", 1)
        ext = "." + parts[1] if len(parts) == 2 else ".jpg"
        local_src = dest_dir / (asset_id + ext)
        try:
            await self.immich.download_original(asset_id, local_src)
        except Exception as e:
            log.error(f"{asset_id}: download failed: {e}")
            db.mark_failed(asset_id, f"download failed: {e}")
            return None
        src_w, src_h = 0, 0
        try:
            from PIL import Image
            with Image.open(local_src) as im:
                src_w, src_h = im.size
        except Exception:
            pass
        return {
            "asset_id": asset_id, "info": info, "filename": filename,
            "src_w": src_w, "src_h": src_h,
            "src_mp": (src_w * src_h) / 1_000_000.0 if src_w and src_h else 0.0,
        }

    async def _do_batch(self, asset_ids: list, gpu: dict):
        model = db.get_setting("model", "seedvr2-7b-fp8")
        gpu_label = f"{gpu['container_name']}:{gpu['cuda_index']} ({gpu['friendly_name']})"
        batch_id = f"batch-{gpu['agent_name']}-{gpu['cuda_index']}-{asset_ids[0][:8]}"
        batch_dir = WORK_DIR / batch_id
        input_dir = batch_dir / "input"
        input_dir.mkdir(parents=True, exist_ok=True)

        metas: dict = {}
        for aid in asset_ids:
            m = await self._prep_asset(aid, gpu, input_dir)
            if m:
                metas[aid] = m
        if not metas:
            self._cleanup_path(batch_dir)
            return

        log.info(f"dispatching batch of {len(metas)} to {gpu_label} (model={model})")
        t0 = time.time()
        produced, completed_ok, log_excerpt = await dispatcher.upscale_batch(
            batch_id, input_dir, model,
            agent_ip=gpu["agent_ip"], cuda_index=gpu["cuda_index"],
        )
        elapsed = time.time() - t0
        per = elapsed / max(1, len(produced))
        log.info(f"batch on {gpu_label}: {len(produced)}/{len(metas)} produced in "
                 f"{elapsed:.1f}s (pipeline_ok={completed_ok})")

        # Finalize produced images individually (per-image completion). For
        # missing ones: if the pipeline finished cleanly it's a genuine failure;
        # if it was interrupted, re-queue so we don't lose progress.
        for aid, meta in metas.items():
            rp = produced.get(aid)
            if rp is not None:
                try:
                    await self._finalize_one(meta, rp, model, per)
                except Exception as e:
                    log.exception(f"{aid}: finalize failed: {e}")
                    self._requeue(aid)
            elif completed_ok:
                log.error(f"{aid}: no output from completed batch")
                db.mark_failed(aid, f"no output produced (batch)\n{log_excerpt[-300:]}")
            else:
                log.warning(f"{aid}: batch interrupted before output -> re-queue")
                self._requeue(aid)
        self._cleanup_path(batch_dir)

    async def _finalize_one(self, meta: dict, result_path, model: str, elapsed: float):
        """Upload the upscaled image, stack + migrate tags, mark done. Mirrors the
        post-processing the single-image path used; called per produced image."""
        asset_id = meta["asset_id"]
        info = meta["info"]
        filename = meta["filename"]
        src_w, src_h, src_mp = meta["src_w"], meta["src_h"], meta["src_mp"]

        dst_w, dst_h = 0, 0
        try:
            from PIL import Image
            with Image.open(result_path) as im:
                dst_w, dst_h = im.size
        except Exception:
            pass

        new = await self.immich.upload_asset(
            result_path, device_id="upscale-companion",
            device_asset_id=f"upscale-companion:{asset_id}",
        )
        new_id = new["id"]
        try:
            await self.immich.copy_asset_metadata(asset_id, new_id,
                                                  albums=True, sidecar=True, stack=False)
        except Exception as e:
            log.warning(f"{asset_id}: copyAsset failed (non-fatal): {e}")
        try:
            stack = await self.immich.create_stack([asset_id, new_id], primary_asset_id=new_id)
            stack_id = stack.get("id") if isinstance(stack, dict) else None
            if stack_id:
                try:
                    await self.immich.update_stack(stack_id, primary_asset_id=new_id)
                except Exception as e:
                    log.warning(f"{asset_id}: update_stack primary failed (non-fatal): {e}")
        except Exception as e:
            log.warning(f"{asset_id}: create_stack failed (non-fatal): {e}")
        original_tag_ids = []
        try:
            original_tag_ids = [t["id"] for t in (info.get("tags") or []) if t.get("id")]
        except Exception:
            pass
        for tid in original_tag_ids:
            try:
                await self.immich.tag_assets(tid, [new_id])
            except Exception as e:
                log.warning(f"{asset_id}: tag {tid[:8]} -> upscaled failed: {e}")
            try:
                await self.immich.untag_assets(tid, [asset_id])
            except Exception as e:
                log.warning(f"{asset_id}: untag {tid[:8]} from orig failed: {e}")
        if self.upscaled_tag_id:
            try:
                await self.immich.tag_assets(self.upscaled_tag_id, [new_id])
            except Exception as e:
                log.warning(f"{asset_id}: tag upscaled failed (non-fatal): {e}")

        db.mark_done(asset_id, new_id, model, src_mp, elapsed, filename=filename,
                     src_w=src_w or None, src_h=src_h or None,
                     dst_w=dst_w or None, dst_h=dst_h or None)
        log.info(f"{asset_id} -> {new_id}  ({src_w}x{src_h} -> {dst_w}x{dst_h})")

    def _requeue(self, asset_id: str):
        """Force an asset back to pending (retry), clearing dispatch state."""
        try:
            with db.conn() as c:
                c.execute(
                    "UPDATE queue SET status='pending', agent_name=NULL, "
                    "cuda_index=NULL, started_at=NULL, last_error=NULL "
                    "WHERE asset_id=?", (asset_id,))
        except Exception as e:
            log.warning(f"{asset_id}: requeue failed: {e}")

    def _cleanup_path(self, p):
        try:
            shutil.rmtree(p, ignore_errors=True)
        except Exception:
            pass

    def _cleanup_local(self, asset_id: str):
        self._cleanup_path(WORK_DIR / asset_id)
