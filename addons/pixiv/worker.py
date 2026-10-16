"""Background scrape + download loops for the Pixiv addon (rule34-style)."""

import asyncio
import logging
import os
import time

from db import (
    get_setting, get_watches, upsert_illust, link_watch, update_watch_progress,
    get_pending_page_downloads, mark_page_downloaded, mark_illust_failed, get_stats,
)
from pixiv_client import client, status as auth_status

logger = logging.getLogger(__name__)


class Worker:
    def __init__(self):
        self.running = False
        self.paused = False
        self._tasks: list[asyncio.Task] = []
        self._scraping = False
        self._activity = "idle"
        self._progress = ""
        self._watch_status: dict = {}
        self._scrapes = 0
        self._downloads = 0

    @property
    def status(self) -> dict:
        return {
            "running": self.running, "paused": self.paused,
            "activity": self._activity, "scrape_progress": self._progress,
            "scrapes_completed": self._scrapes, "downloads_completed": self._downloads,
            "watch_status": self._watch_status,
            "auth": dict(auth_status),
            "api_error": client.last_api_error,
        }

    async def start(self):
        self.running = True
        self._tasks = [asyncio.create_task(self._scrape_loop()),
                       asyncio.create_task(self._download_loop())]
        logger.info("Pixiv worker started")

    async def stop(self):
        self.running = False
        for t in self._tasks:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
        logger.info("Pixiv worker stopped")

    def pause(self):
        self.paused = True
        self._activity = "paused"

    def resume(self):
        self.paused = False
        self._activity = "idle"

    async def scrape_watch_now(self, watch: dict):
        wid, kind, value = watch["id"], watch["kind"], watch["value"]
        label = watch.get("label") or value
        self._scraping = True
        self._activity = f"scraping {kind}: {label}"
        self._progress = ""
        since = watch.get("last_illust_id") or 0
        max_id = since
        found = 0
        try:
            async for page in client.iter_watch_pages(
                kind, value, since_id=since,
                on_progress=lambda n: setattr(self, "_progress", f"{label}: {n:,} scanned"),
            ):
                ids = []
                for il in page:
                    await upsert_illust(il)
                    ids.append(il["id"])
                    if il["id"] > max_id:
                        max_id = il["id"]
                await link_watch(wid, ids)
                found += len(ids)
            await update_watch_progress(wid, max_id)
            self._scrapes += 1
            self._watch_status[wid] = {"found": found, "at": time.time(), "error": None}
            logger.info(f"Scrape complete for {kind} '{value}': {found} new illusts")
        except Exception as e:
            self._watch_status[wid] = {"found": found, "at": time.time(), "error": str(e)[:200]}
            logger.error(f"Scrape error for {kind} '{value}': {e}")
        finally:
            self._scraping = False
            self._activity = "idle"
            self._progress = ""

    async def _scrape_loop(self):
        while self.running:
            try:
                if not self.paused:
                    for w in await get_watches():
                        if not self.running:
                            break
                        if w["enabled"]:
                            await self.scrape_watch_now(w)
                poll = int(await get_setting("poll_interval_sec") or "3600")
                await asyncio.sleep(poll)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Scrape loop error: {e}")
                await asyncio.sleep(60)

    async def _download_loop(self):
        while self.running:
            try:
                if self.paused:
                    await asyncio.sleep(5)
                    continue
                pending = await get_pending_page_downloads(limit=30)
                if not pending:
                    await asyncio.sleep(10)
                    continue
                conc = int(await get_setting("download_concurrency") or "2")
                sem = asyncio.Semaphore(conc)

                async def one(pg: dict):
                    async with sem:
                        if self.running and not self.paused:
                            await self._download_page(pg)

                self._activity = f"downloading ({len(pending)} pages pending)"
                await asyncio.gather(*[one(p) for p in pending])
                self._activity = "idle"
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Download loop error: {e}")
                await asyncio.sleep(30)

    async def _download_page(self, pg: dict):
        storage = await get_setting("storage_path") or "/nas/zpoolalpha/media/xxx/pixiv"
        url = pg["url"]
        ext = os.path.splitext(url.split("?")[0])[1].lstrip(".") or "jpg"
        # <artist_id>/<illust>_p<page>.<ext> — pixiv's own naming convention, so
        # files remain recognisable outside the addon.
        rel = f"{pg.get('artist_id') or 'unknown'}/{pg['illust_id']}_p{pg['page_no']}.{ext}"
        full = os.path.join(storage, rel)
        if os.path.exists(full) and os.path.getsize(full) > 0:
            await mark_page_downloaded(pg["illust_id"], pg["page_no"], rel)
            self._downloads += 1
            return
        res, detail = await client.download(url, full)
        if res == "ok":
            await mark_page_downloaded(pg["illust_id"], pg["page_no"], rel)
            self._downloads += 1
        elif res == "permanent":
            await mark_illust_failed(pg["illust_id"], f"permanent: {detail}", permanent=True)
        else:
            await mark_illust_failed(pg["illust_id"], detail)


worker = Worker()
