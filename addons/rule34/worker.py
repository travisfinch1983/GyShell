"""Background async worker for scrape and download loops."""

import asyncio
import logging
import os
import time

from db import (
    get_setting,
    get_watched_tags,
    upsert_post,
    upsert_tags_for_post,
    get_pending_downloads,
    get_pending_downloads_for_tag,
    mark_downloaded,
    mark_download_failed,
    requeue_download,
    update_watched_tag_progress,
    link_posts_to_watched_tag,
    refresh_watched_agg,
    backfill_watched_tag_links,
    get_untyped_tags,
    set_tag_type_by_name,
)
from scraper import Rule34Client, parse_post

logger = logging.getLogger(__name__)

# How many times to auto-requeue a transiently-failing download before giving
# up and marking it permanently failed (guards against a genuinely stuck item
# looping forever). With exponential backoff this spans hours.
MAX_DOWNLOAD_REQUEUES = 8


class Worker:
    def __init__(self):
        self.client = Rule34Client()
        self.running = False
        self.paused = False
        self._scrape_task: asyncio.Task | None = None
        self._download_task: asyncio.Task | None = None
        self._agg_task: asyncio.Task | None = None
        self._type_task: asyncio.Task | None = None
        self._scraping: bool = False          # true while a scrape is running
        self._type_priority: list[str] = []   # tag names to type ASAP (viewed posts)
        self._type_count: int = 0
        self._current_activity: str = "idle"
        self._scrape_progress: str = ""
        self._tag_scrape: dict = {}   # tag_id -> {found, at, error}
        self._priority_tag_id: int | None = None      # Sync-Now download priority
        self._priority_tag_query: str | None = None
        self._current_download_tag: str | None = None # tag whose images are downloading now
        self._scrape_count: int = 0
        self._download_count: int = 0
        self._requeue_count: int = 0    # transient failures auto-requeued

    @property
    def status(self) -> dict:
        return {
            "running": self.running,
            "paused": self.paused,
            "activity": self._current_activity,
            "scrapes_completed": self._scrape_count,
            "downloads_completed": self._download_count,
            "downloads_requeued": self._requeue_count,
            "tags_typed": self._type_count,
            "scrape_progress": self._scrape_progress,
            "tag_status": self._tag_scrape,
            "api_error": self.client.last_api_error,
            "priority_tag_id": self._priority_tag_id,
            "current_download_tag": self._current_download_tag,
        }

    async def start(self):
        self.running = True
        self._scrape_task = asyncio.create_task(self._scrape_loop())
        self._download_task = asyncio.create_task(self._download_loop())
        self._agg_task = asyncio.create_task(self._agg_refresh_loop())
        asyncio.create_task(self._startup_backfill())
        self._type_task = asyncio.create_task(self._type_loop())
        logger.info("Worker started")

    async def stop(self):
        self.running = False
        if self._scrape_task:
            self._scrape_task.cancel()
            try:
                await self._scrape_task
            except asyncio.CancelledError:
                pass
        if self._download_task:
            self._download_task.cancel()
            try:
                await self._download_task
            except asyncio.CancelledError:
                pass
        if self._agg_task:
            self._agg_task.cancel()
            try:
                await self._agg_task
            except asyncio.CancelledError:
                pass
        if self._type_task:
            self._type_task.cancel()
            try:
                await self._type_task
            except asyncio.CancelledError:
                pass
        await self.client.close()
        logger.info("Worker stopped")

    def pause(self):
        self.paused = True
        self._current_activity = "paused"

    def resume(self):
        self.paused = False
        self._current_activity = "idle"

    async def scrape_tag_now(self, tag_query: str, tag_id: int, since_id: int = 0):
        """Run a scrape for a specific tag immediately."""
        self._current_activity = f"scraping: {tag_query}"
        self._scraping = True
        self._scrape_progress = ""
        logger.info(f"Scraping tag: {tag_query} (since_id={since_id})")
        max_id = since_id
        total_linked = 0
        try:
            async for page in self.client.iter_post_pages(
                tag_query, since_id=since_id,
                on_progress=lambda n: setattr(self, "_scrape_progress", f"{tag_query}: {n:,} scanned"),
            ):
                page_ids: list[int] = []
                for raw in page:
                    post = parse_post(raw)
                    if post["id"] is None:
                        continue
                    inserted = await upsert_post(post)
                    if inserted:
                        await upsert_tags_for_post(post["id"], post["tags"])
                    page_ids.append(post["id"])
                    if post["id"] > max_id:
                        max_id = post["id"]
                # Link this page incrementally: junction (live counts + download
                # prioritization) populates progressively and survives interruptions.
                await link_posts_to_watched_tag(tag_id, page_ids)
                total_linked += len(page_ids)
            # Advance last_post_id only on FULL completion (backward pagination: a
            # mid-scrape advance would skip the un-fetched older pages on resume).
            await update_watched_tag_progress(tag_id, max_id)
            self._scrape_count += 1
            logger.info(f"Scrape complete for '{tag_query}': {total_linked} posts linked")
            _err = None
            if total_linked == 0 and self.client.last_api_error:
                _err = self.client.last_api_error.get("error")
            self._tag_scrape[tag_id] = {"found": total_linked, "at": time.time(), "error": _err}
        except Exception as e:
            logger.error(f"Scrape error for '{tag_query}': {e}")
            self._tag_scrape[tag_id] = {"found": total_linked, "at": time.time(), "error": str(e)}
        finally:
            self._scraping = False
            self._current_activity = "idle"
            self._scrape_progress = ""

    async def _scrape_loop(self):
        """Periodically scrape all enabled watched tags."""
        while self.running:
            try:
                if not self.paused:
                    watched = await get_watched_tags()
                    for wt in watched:
                        if not self.running:
                            break
                        if not wt["enabled"]:
                            continue
                        await self.scrape_tag_now(
                            wt["tag_query"], wt["id"], wt["last_post_id"]
                        )
                poll_sec = int(await get_setting("poll_interval_sec") or "3600")
                await asyncio.sleep(poll_sec)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Scrape loop error: {e}")
                await asyncio.sleep(60)

    async def _download_loop(self):
        """Continuously download pending posts."""
        while self.running:
            try:
                if self.paused:
                    await asyncio.sleep(5)
                    continue

                # Sticky priority: while a tag is prioritised, download its images first;
                # when it has none pending right now, fall back to the global queue for this
                # batch but KEEP the priority (its scrape may still be linking more posts).
                pending = []
                if self._priority_tag_id is not None:
                    pending = await get_pending_downloads_for_tag(self._priority_tag_id, limit=50)
                if pending:
                    self._current_download_tag = self._priority_tag_query
                else:
                    pending = await get_pending_downloads(limit=50)
                    self._current_download_tag = None
                if not pending:
                    await asyncio.sleep(10)
                    continue

                concurrency = int(await get_setting("download_concurrency") or "3")
                sem = asyncio.Semaphore(concurrency)
                max_retries = int(await get_setting("max_retries") or "3")

                async def download_one(post: dict):
                    async with sem:
                        if not self.running or self.paused:
                            return
                        await self._download_post(post, max_retries)

                self._current_activity = f"downloading {self._current_download_tag or 'queue'} ({len(pending)} pending)"
                await asyncio.gather(*[download_one(p) for p in pending])
                self._current_activity = "idle"

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Download loop error: {e}")
                await asyncio.sleep(30)

    async def _startup_backfill(self):
        """One-shot on boot: backfill watched-tag->post links so dashboard live
        counts reflect posts downloaded before incremental linking existed."""
        try:
            n = await backfill_watched_tag_links()
            logger.info(f"Watched-tag link backfill linked {n} posts")
            await refresh_watched_agg()
        except Exception as e:
            logger.error(f"Backfill error: {e}")

    async def _agg_refresh_loop(self):
        """Keep the watched-tag live-count cache warm so the dashboard/browser
        never block on the heavy junction aggregation."""
        while self.running:
            try:
                await refresh_watched_agg()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Agg refresh error: {e}")
            await asyncio.sleep(30)

    def request_tag_types(self, names: list[str]):
        """Bump tag names to the front of the typing queue (called when a post
        is viewed) so its tags get typed within seconds."""
        for n in names:
            if n and n not in self._type_priority:
                self._type_priority.append(n)
        if len(self._type_priority) > 500:
            self._type_priority = self._type_priority[-500:]

    async def _type_loop(self):
        """Backfill tag types (artist/character/copyright/…) from the tag API.
        Priority queue (viewed posts) first, then most-common untyped tags.
        Yields to active scrapes so scraping keeps its API budget."""
        while self.running:
            try:
                if self.paused or self._scraping:
                    await asyncio.sleep(3)
                    continue
                # 1) Priority names from recently-viewed posts.
                if self._type_priority:
                    name = self._type_priority.pop(0)
                    typ = await self.client.fetch_tag_type(name)
                    if typ is not None:
                        await set_tag_type_by_name(name, typ)
                        self._type_count += 1
                    continue
                # 2) Otherwise chew through the most-common untyped tags.
                batch = await get_untyped_tags(limit=50)
                if not batch:
                    await asyncio.sleep(300)  # all caught up; recheck for new tags
                    continue
                for t in batch:
                    if not self.running or self.paused or self._scraping or self._type_priority:
                        break
                    typ = await self.client.fetch_tag_type(t["name"])
                    if typ is not None:
                        await set_tag_type_by_name(t["name"], typ)
                        self._type_count += 1
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Type loop error: {e}")
                await asyncio.sleep(30)

    async def _download_post(self, post: dict, max_retries: int):
        """Download a single post's media file."""
        storage_path = await get_setting("storage_path") or "/nas/zpoolalpha/media/xxx/rule34"
        rating = post.get("rating", "e") or "e"
        ext = post.get("file_ext", "jpg") or "jpg"
        relative_path = f"{rating}/{post['id']}.{ext}"
        full_path = os.path.join(storage_path, relative_path)

        # Skip if already exists on disk
        if os.path.exists(full_path):
            await mark_downloaded(post["id"], relative_path)
            self._download_count += 1
            return

        url = post.get("file_url", "")
        if not url:
            await mark_download_failed(post["id"], "no file_url")
            return

        status, detail = await self.client.download_file(url, full_path)
        if status == "ok":
            await mark_downloaded(post["id"], relative_path)
            self._download_count += 1
            return
        if status == "permanent":
            # 404/410 etc — the file is gone; retrying will never help.
            await mark_download_failed(post["id"], f"permanent: {detail}")
            return

        # Transient (429 rate-limit / 5xx / timeout / network): auto-requeue with
        # exponential backoff instead of failing. Capped so a stuck item can't
        # loop forever — after the cap it's marked failed WITH the real reason.
        attempts = int(post.get("download_attempts") or 0) + 1
        if attempts >= MAX_DOWNLOAD_REQUEUES:
            await mark_download_failed(
                post["id"], f"transient, gave up after {attempts} tries: {detail}"
            )
        else:
            delay = min(30 * (2 ** (attempts - 1)), 1800)  # 30s .. 30min
            next_at = int(time.time()) + delay
            await requeue_download(
                post["id"], f"requeued ({attempts}): {detail}", attempts, next_at
            )
            self._requeue_count += 1


# Singleton worker instance
worker = Worker()
