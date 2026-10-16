"""Pixiv app-API client (pixivpy3) behind an async facade.

AUTH: an OAuth REFRESH TOKEN only — pixiv has no official API keys, and
password login died in 2021. The token is read at runtime from the AI-Lab
vault (settings pixiv_token_cred_id names the credential; its tokenSecret
field holds the token) or the settings override pixiv_refresh_token. NEVER
in code, git, or fleet. Access tokens last ~1h and refresh automatically.

TOKEN DEATH IS LOUD: this is Travis's real account — pixiv can invalidate
the token at any time. invalid_grant flips status to 'token dead' and emits
ONE notification (re-armed by a later success), because a scraper that
silently stops is how an archive quietly goes stale.

pixivpy3 is synchronous (requests) — every call runs in a thread behind a
global min-interval limiter (default 1.2s between calls; downloads share it).
"""

import asyncio
import json
import logging
import os
import time

import httpx

from db import get_setting

logger = logging.getLogger(__name__)

AILAB_API = "http://127.0.0.1:17890"

status: dict = {"auth": "no token", "detail": "no refresh token configured", "checked_at": 0.0,
                "account": ""}


def _notify(severity: str, message: str, detail: str):
    try:
        httpx.post(f"{AILAB_API}/api/notifications/emit",
                   json={"severity": severity, "source": "pixiv-addon",
                         "message": message, "detail": detail}, timeout=5)
    except Exception as e:
        logger.warning(f"notify lost: {e}")


class PixivClient:
    def __init__(self):
        self._api = None                    # AppPixivAPI, created lazily
        self._expires_at = 0.0
        self._lock = asyncio.Lock()
        self._last_call = 0.0
        self._token_dead_notified = False
        self.last_api_error: dict | None = None

    # ── token & auth ─────────────────────────────────────────────────────────

    async def _refresh_token(self) -> str:
        tok = (await get_setting("pixiv_refresh_token") or "").strip()
        if tok:
            return tok
        cred_id = (await get_setting("pixiv_token_cred_id") or "").strip()
        if not cred_id:
            return ""
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.get(f"{AILAB_API}/api/ai/credentials/{cred_id}", params={"reveal": "1"})
                r.raise_for_status()
                return (r.json().get("tokenSecret") or "").strip()
        except Exception as e:
            logger.warning(f"vault read {cred_id} failed: {e}")
            return ""

    async def _ensure_auth(self) -> bool:
        async with self._lock:
            now = time.time()
            if self._api is not None and now < self._expires_at - 60:
                return True
            tok = await self._refresh_token()
            if not tok:
                status.update(auth="no token", checked_at=now,
                              detail="no refresh token (set pixiv_token_cred_id to the vault "
                                     "credential, or paste a token in settings)")
                return False
            from pixivpy3 import AppPixivAPI
            if self._api is None:
                self._api = AppPixivAPI()
            try:
                res = await asyncio.to_thread(self._api.auth, refresh_token=tok)
                self._expires_at = now + int(getattr(res, "expires_in", 3600) or 3600)
                user = getattr(getattr(res, "user", None), "account", "") or ""
                status.update(auth="authenticated", checked_at=now, account=user,
                              detail=f"authenticated as {user}")
                if self._token_dead_notified:
                    _notify("info", "pixiv token works again",
                            f"Re-authenticated as {user}; scraping resumes.")
                    self._token_dead_notified = False
                return True
            except Exception as e:
                msg = str(e)
                dead = "invalid_grant" in msg or "Error occurred at the OAuth process" in msg
                status.update(auth="token dead" if dead else "auth error", checked_at=now,
                              detail=msg[:200])
                if dead and not self._token_dead_notified:
                    _notify("warning", "pixiv refresh token REJECTED — scraping stopped",
                            "Pixiv refused the stored refresh token (invalid_grant). The addon "
                            "keeps retrying hourly, but a new token must be minted (gppt login) "
                            "and stored in the vault. Until then nothing new is scraped — "
                            "existing downloads are unaffected.")
                    self._token_dead_notified = True
                logger.error(f"pixiv auth failed: {msg}")
                return False

    # ── rate limit ───────────────────────────────────────────────────────────

    async def _pace(self):
        try:
            interval = float(await get_setting("pixiv_min_interval_sec") or "1.2")
        except (TypeError, ValueError):
            interval = 1.2
        now = time.monotonic()
        wait = self._last_call + interval - now
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_call = time.monotonic()

    async def _call(self, fn, *args, **kwargs):
        """Auth + pace + run a pixivpy call in a thread, with 429/5xx backoff."""
        if not await self._ensure_auth():
            raise RuntimeError(f"pixiv not authenticated: {status['detail']}")
        for attempt in range(4):
            await self._pace()
            res = await asyncio.to_thread(fn, *args, **kwargs)
            err = getattr(res, "error", None)
            if err:
                msg = str(getattr(err, "message", "") or getattr(err, "user_message", "") or err)[:200]
                if "Rate Limit" in msg or "429" in msg:
                    wait = 30 * (2 ** attempt)
                    logger.warning(f"pixiv rate limited, waiting {wait}s")
                    await asyncio.sleep(wait)
                    continue
                self.last_api_error = {"error": f"pixiv: {msg}", "at": time.time()}
                raise RuntimeError(f"pixiv API error: {msg}")
            self.last_api_error = None
            return res
        self.last_api_error = {"error": "pixiv: exhausted rate-limit retries", "at": time.time()}
        raise RuntimeError("pixiv: exhausted rate-limit retries")

    # ── parsing ──────────────────────────────────────────────────────────────

    @staticmethod
    def parse_illust(il) -> dict | None:
        """pixivpy JsonDict → our row. None for deleted/invisible illusts."""
        if not il or not il.get("id") or not il.get("visible", True):
            return None
        tags = [{"name": t.get("name", ""), "translated": t.get("translated_name") or ""}
                for t in (il.get("tags") or [])]
        flat = " ".join(filter(None, [t["name"] for t in tags] + [t["translated"] for t in tags])).lower()
        pages = []
        if il.get("page_count", 1) <= 1:
            orig = (il.get("meta_single_page") or {}).get("original_image_url") \
                or (il.get("image_urls") or {}).get("large", "")
            if orig:
                pages.append({"page_no": 0, "url": orig,
                              "preview_url": (il.get("image_urls") or {}).get("square_medium")})
        else:
            for n, mp in enumerate(il.get("meta_pages") or []):
                urls = mp.get("image_urls") or {}
                u = urls.get("original") or urls.get("large")
                if u:
                    pages.append({"page_no": n, "url": u, "preview_url": urls.get("square_medium")})
        if not pages:
            return None
        return {
            "id": int(il["id"]),
            "title": il.get("title", ""),
            "type": il.get("type", "illust"),
            "artist_id": (il.get("user") or {}).get("id"),
            "artist_name": (il.get("user") or {}).get("name", ""),
            "tags": json.dumps(tags, ensure_ascii=False),
            "tags_flat": flat,
            "x_restrict": il.get("x_restrict", 0),
            "page_count": il.get("page_count", 1),
            "width": il.get("width"), "height": il.get("height"),
            "bookmarks": il.get("total_bookmarks", 0), "views": il.get("total_view", 0),
            "create_date": il.get("create_date"),
            "pages": pages,
        }

    # ── iteration (newest-first, stop at since_id) ───────────────────────────

    async def iter_watch_pages(self, kind: str, value: str, since_id: int = 0, on_progress=None):
        """Yields lists of parsed NEW illusts (id > since_id) for a watch.
        kind 'tag' walks search_illust (partial tag match); 'artist' walks
        user_illusts for the user id. Pixiv pages via next_url offsets."""
        if not await self._ensure_auth():
            raise RuntimeError(f"pixiv not authenticated: {status['detail']}")
        api = self._api
        qs: dict | None = None
        total = 0
        while True:
            if kind == "artist":
                res = await self._call(api.user_illusts, int(value)) if qs is None \
                    else await self._call(api.user_illusts, **qs)
            else:
                res = await self._call(api.search_illust, value, search_target="partial_match_for_tags") \
                    if qs is None else await self._call(api.search_illust, **qs)
            illusts = res.get("illusts") or []
            if not illusts:
                break
            parsed = [p for p in (self.parse_illust(i) for i in illusts) if p]
            new = [p for p in parsed if p["id"] > since_id]
            if new:
                total += len(new)
                if on_progress:
                    try:
                        on_progress(total)
                    except Exception:
                        pass
                yield new
            if len(new) < len(parsed):
                break           # reached already-seen territory
            nxt = res.get("next_url")
            if not nxt:
                break
            qs = api.parse_qs(nxt)
            if not qs:
                break

    # ── downloads ────────────────────────────────────────────────────────────

    async def download(self, url: str, dest_path: str) -> tuple[str, str]:
        """i.pximg.net requires the app-api Referer or it 403s everything."""
        await self._pace()
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(60.0, connect=10.0), follow_redirects=True,
                headers={"Referer": "https://app-api.pixiv.net/",
                         "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)"},
            ) as c:
                async with c.stream("GET", url) as resp:
                    if resp.status_code in (404, 410):
                        return ("permanent", f"HTTP {resp.status_code}")
                    if resp.status_code in (403,):
                        return ("permanent", "HTTP 403 (removed or restricted)")
                    if resp.status_code in (429, 500, 502, 503):
                        return ("transient", f"HTTP {resp.status_code}")
                    resp.raise_for_status()
                    with open(dest_path, "wb") as f:
                        async for chunk in resp.aiter_bytes(chunk_size=65536):
                            f.write(chunk)
            return ("ok", "")
        except (httpx.TimeoutException, httpx.TransportError) as e:
            try:
                if os.path.exists(dest_path):
                    os.remove(dest_path)
            except OSError:
                pass
            return ("transient", type(e).__name__)
        except Exception as e:
            try:
                if os.path.exists(dest_path):
                    os.remove(dest_path)
            except OSError:
                pass
            return ("transient", str(e)[:100])


client = PixivClient()
