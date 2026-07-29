"""Rule34.xxx API client for searching and downloading posts."""

import asyncio
import time
import re
import html
import httpx
import os
import logging
from collections import deque
from urllib.parse import urlparse

from db import get_setting, get_enabled_api_keys

logger = logging.getLogger(__name__)

API_BASE = "https://api.rule34.xxx/index.php"
MAX_429_RETRIES = 5


def _rm_partial(path: str) -> None:
    """Remove a partial/failed download file, ignoring errors."""
    if path and os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


class _BandwidthLimiter:
    """Global async token-bucket. Caps TOTAL download throughput across all
    concurrent downloads to `rate_bps` bytes/sec (0 = unlimited). Each chunk
    reserves the next time-slot under a shared lock, so N parallel downloads
    together stay under the cap."""

    def __init__(self):
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def throttle(self, nbytes: int, rate_bps: float) -> None:
        if rate_bps <= 0 or nbytes <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            if self._next < now:
                self._next = now
            wait = self._next - now
            self._next += nbytes / rate_bps
        if wait > 0:
            await asyncio.sleep(wait)


_bw_limiter = _BandwidthLimiter()


class KeyPool:
    """Load-balances API requests across multiple rule34 API keys.

    Each key gets its own sliding-window budget (default 60 requests / 60s).
    acquire() round-robins across enabled keys and returns one that currently
    has budget, waiting only when *every* key is saturated. Effective ceiling
    scales with the number of enabled keys — provided the site rate-limits per
    key rather than per IP. Each key may carry its own proxy for a distinct IP.
    """

    def __init__(self):
        self._keys: list[dict] = []          # {id, api_key, user_id, proxy, ts}
        self._rr = 0
        self._lock = asyncio.Lock()
        self._loaded_at = 0.0
        self._max_req = 60
        self._window = 60.0

    async def _ensure_loaded(self):
        now = time.monotonic()
        if self._keys and now - self._loaded_at < 20:
            return
        rows = await get_enabled_api_keys()
        try:
            self._max_req = int(await get_setting("rate_limit_requests") or "60")
            self._window = float(await get_setting("rate_limit_window_sec") or "60")
        except (TypeError, ValueError):
            self._max_req, self._window = 60, 60.0
        existing = {k["id"]: k for k in self._keys}
        merged = []
        for r in rows:
            k = existing.get(r["id"])
            if k:
                k["api_key"], k["user_id"], k["proxy"] = (
                    r["api_key"], r["user_id"], r.get("proxy") or "")
            else:
                k = {"id": r["id"], "api_key": r["api_key"], "user_id": r["user_id"],
                     "proxy": r.get("proxy") or "", "ts": deque()}
            merged.append(k)
        self._keys = merged
        self._loaded_at = now

    async def acquire(self) -> tuple[str | None, str | None, str]:
        """Reserve a slot on an available key; returns (api_key, user_id, proxy).
        (None, None, "") when no keys are configured (unauthenticated + direct)."""
        while True:
            async with self._lock:
                await self._ensure_loaded()
                if not self._keys:
                    return None, None, ""
                now = time.monotonic()
                soonest = None
                n = len(self._keys)
                for i in range(n):
                    k = self._keys[(self._rr + i) % n]
                    while k["ts"] and now - k["ts"][0] >= self._window:
                        k["ts"].popleft()
                    if len(k["ts"]) < self._max_req:
                        k["ts"].append(now)
                        self._rr = (self._rr + i + 1) % n
                        return k["api_key"], k["user_id"], k.get("proxy") or ""
                    free_at = k["ts"][0] + self._window
                    if soonest is None or free_at < soonest:
                        soonest = free_at
                wait = max(0.05, (soonest or now) - now)
            await asyncio.sleep(min(wait, 5.0))


key_pool = KeyPool()


class Rule34Client:
    def __init__(self):
        # One httpx client per distinct proxy ("" == direct) so proxied keys
        # get a genuinely separate source IP.
        self._clients: dict[str, httpx.AsyncClient] = {}
        self._last_request_time: float = 0

    def _client_for(self, proxy: str = "") -> httpx.AsyncClient:
        c = self._clients.get(proxy)
        if c is None or c.is_closed:
            c = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, connect=10.0),
                follow_redirects=True,
                headers={"User-Agent": "AI-Lab-Rule34-Scraper/1.0"},
                proxy=(proxy or None),
            )
            self._clients[proxy] = c
        return c

    async def _get_client(self) -> httpx.AsyncClient:
        return self._client_for("")

    async def _rate_limit(self):
        rps = float(await get_setting("rate_limit_rps") or "2")
        delay = 1.0 / rps
        now = asyncio.get_event_loop().time()
        elapsed = now - self._last_request_time
        if elapsed < delay:
            await asyncio.sleep(delay - elapsed)
        self._last_request_time = asyncio.get_event_loop().time()

    async def search_posts(
        self, tags: str, page: int = 0, limit: int = 1000
    ) -> list[dict]:
        """Search rule34.xxx for posts matching tags.
        Returns list of post dicts. Retries on 429 with backoff."""
        base_params = {
            "page": "dapi",
            "s": "post",
            "q": "index",
            "json": "1",
            "tags": tags,
            "pid": str(page),
            "limit": str(limit),
        }

        for attempt in range(MAX_429_RETRIES):
            # The pool picks a key (round-robin) and enforces its per-key rate
            # limit, blocking only when every key is saturated. Each key may
            # carry its own proxy for a distinct source IP.
            api_key, user_id, proxy = await key_pool.acquire()
            client = self._client_for(proxy)
            params = dict(base_params)
            if api_key:
                params["api_key"] = api_key
            if user_id:
                params["user_id"] = user_id
            try:
                resp = await client.get(API_BASE, params=params)
                if resp.status_code == 429:
                    wait = 2 ** (attempt + 1)
                    logger.warning(f"429 rate-limited on '{tags}' page {page}, waiting {wait}s (attempt {attempt+1}/{MAX_429_RETRIES})")
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                text = resp.text.strip()
                if not text:
                    return []
                data = resp.json()
                if isinstance(data, list):
                    return data
                # API sometimes returns a string error message
                if isinstance(data, str):
                    logger.warning(f"API returned string for '{tags}' page {page}: {data[:100]}")
                return []
            except httpx.HTTPStatusError as e:
                logger.error(f"API error searching '{tags}' page {page}: {e.response.status_code}")
                return []
            except Exception as e:
                logger.error(f"Error searching '{tags}' page {page}: {e}")
                return []

        logger.error(f"Exhausted retries for '{tags}' page {page} due to 429s")
        return []

    async def fetch_all_posts(self, tags: str, since_id: int = 0) -> list[dict]:
        """Fetch all posts for a tag query using ID-based pagination.

        Uses id:<MIN_ID to walk backwards through results instead of pid,
        which avoids the rule34 API's pid pagination limit.
        """
        all_posts = []
        current_tags = tags
        page_num = 0

        while True:
            posts = await self.search_posts(current_tags, page=0, limit=1000)
            if not posts:
                break

            new_posts = [p for p in posts if p.get("id", 0) > since_id]
            all_posts.extend(new_posts)
            page_num += 1

            if len(new_posts) < len(posts):
                # We've reached posts at or below since_id — done
                break
            if len(posts) < 1000:
                # Last page — fewer results than limit means no more
                break

            # ID-based pagination: get the minimum ID from this batch,
            # then request posts with id < that minimum
            min_id = min(p.get("id", 0) for p in posts)
            if min_id <= since_id + 1:
                break
            current_tags = f"{tags} id:<{min_id}"

            if page_num % 10 == 0:
                logger.info(f"Pagination progress for '{tags}': {len(all_posts)} posts fetched so far (page {page_num})")

        return all_posts

    async def fetch_tag_type(self, name: str) -> int | None:
        """Fetch one tag's type from the rule34 tag API (XML). Type codes:
        0=general, 1=artist, 3=copyright, 4=character, 5=metadata. Returns None
        on error. Goes through the key pool, so it shares the per-key budget."""
        api_key, user_id, proxy = await key_pool.acquire()
        client = self._client_for(proxy)
        params = {"page": "dapi", "s": "tag", "q": "index", "name": name}
        if api_key:
            params["api_key"] = api_key
        if user_id:
            params["user_id"] = user_id
        try:
            resp = await client.get(API_BASE, params=params)
            resp.raise_for_status()
            # <tag type="N" count=".." name=".." .../> — prefer the exact-name
            # match (an ambiguous query can return several).
            best = None
            for m in re.finditer(r"<tag\b([^>]*?)/?>", resp.text):
                attrs = m.group(1)
                tm = re.search(r'\btype="(\d+)"', attrs)
                if not tm:
                    continue
                t = int(tm.group(1))
                nm = re.search(r'\bname="([^"]*)"', attrs)
                got = html.unescape(nm.group(1)) if nm else ""
                if got == name:
                    return t
                if best is None:
                    best = t
            return best
        except Exception as e:
            logger.warning(f"tag type fetch failed for '{name}': {e}")
            return None

    async def download_file(self, url: str, dest_path: str) -> tuple[str, str]:
        """Download a file from URL to dest_path.

        Returns (status, detail):
          "ok"        -> saved successfully
          "permanent" -> will never succeed (HTTP 404/410) -> mark failed, no requeue
          "transient" -> temporary (429 rate-limit / 5xx / timeout / network) ->
                         safe to requeue and retry later
        `detail` is a short reason recorded on the post so failure modes are
        diagnosable later (e.g. "HTTP 429 (rate limited)", "ReadTimeout", "HTTP 503").
        Retries 429s internally with backoff before giving up as transient.
        """
        client = await self._get_client()
        last_detail = "unknown error"
        for attempt in range(MAX_429_RETRIES):
            await self._rate_limit()
            try:
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                async with client.stream("GET", url) as resp:
                    if resp.status_code == 429:
                        last_detail = "HTTP 429 (rate limited)"
                        wait = min(2.0 * (2 ** attempt), 30.0)
                        logger.warning(
                            f"429 downloading {url}: waiting {wait}s "
                            f"(attempt {attempt + 1}/{MAX_429_RETRIES})"
                        )
                        await asyncio.sleep(wait)
                        continue
                    resp.raise_for_status()
                    rate_bps = float(await get_setting("download_bandwidth_limit_kbps") or "0") * 1024.0
                    with open(dest_path, "wb") as f:
                        async for chunk in resp.aiter_bytes(chunk_size=65536):
                            f.write(chunk)
                            await _bw_limiter.throttle(len(chunk), rate_bps)
                return ("ok", "")
            except httpx.HTTPStatusError as e:
                _rm_partial(dest_path)
                code = e.response.status_code
                if code in (404, 410):
                    return ("permanent", f"HTTP {code}")
                if code == 429:
                    last_detail = "HTTP 429 (rate limited)"
                    await asyncio.sleep(min(2.0 * (2 ** attempt), 30.0))
                    continue
                # 403 / 5xx / anything else -> treat as temporary, worth retrying
                return ("transient", f"HTTP {code}")
            except (httpx.TimeoutException, httpx.TransportError) as e:
                _rm_partial(dest_path)
                return ("transient", type(e).__name__)
            except Exception as e:
                _rm_partial(dest_path)
                logger.error(f"Download failed for {url}: {e}")
                return ("transient", str(e)[:100] or type(e).__name__)
        # Exhausted 429 retries
        return ("transient", last_detail)

    async def close(self):
        for c in list(self._clients.values()):
            if not c.is_closed:
                await c.aclose()
        self._clients.clear()


def parse_post(raw: dict) -> dict:
    """Parse a raw API response post into our schema."""
    file_url = raw.get("file_url", "")
    ext = ""
    if file_url:
        path = urlparse(file_url).path
        ext = os.path.splitext(path)[1].lstrip(".")

    return {
        "id": raw.get("id"),
        "file_url": file_url,
        "preview_url": raw.get("preview_url"),
        "sample_url": raw.get("sample_url"),
        "tags": raw.get("tags", ""),
        "score": raw.get("score", 0),
        "rating": raw.get("rating"),
        "source": raw.get("source", ""),
        "width": raw.get("width"),
        "height": raw.get("height"),
        "file_ext": ext,
        "file_size": raw.get("file_size"),
        "created_at": raw.get("created_at"),
    }
