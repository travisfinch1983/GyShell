"""Multi-site booru clients: rule34.xxx, danbooru.donmai.us, gelbooru.com.

ONE scraper, a site dimension (Travis, 2026-10-16). Each site gets its own
client + conservative rate limiter; every client yields posts in the UNIFIED
shape (see unify fields below), keyed (site, site_post_id), with the original
file's md5 when the site exposes it — the md5 is what cross-site dedup keys on.

CREDENTIALS are never in code or git. Order of precedence per site:
  1. addon settings (SettingsView writes them into the addon's own DB),
  2. the AI-Lab vault at runtime (GET 127.0.0.1:17890/api/ai/credentials/<id>?reveal=1):
     danbooru cred-385f3ba4 (username + tokenSecret=api_key),
     gelbooru cred-633bfa3d (tokenId=user_id, tokenSecret=api_key).
Danbooru auth is VALIDATED once per cache window via profile.json: a bad key
must not poison every search (it returns Access denied on EVERY request), so
on validation failure the client drops to anonymous and says so in status.

Per-site query rules (verified live 2026-10-16):
  * danbooru: free/anon accounts search at most 2 tags (PostQuery::TagLimitError).
    Travis's rule: use the FIRST TWO tags as listed, no splitting/post-filtering;
    the UI hints when truncation happened. Pagination: page=b<lowest_id> cursor
    (does not count toward the tag limit). Ratings are single letters -> stored
    as full words (general/sensitive/questionable/explicit) to match existing
    data (local paths are '<rating>/<id>.<ext>').
  * gelbooru: same dapi as rule34; id:<N pagination verified working; response
    is {"@attributes":..., "post":[...]} (or a bare list on some queries).
  * rule34: existing scraper.py client (key pool, proxies) wrapped unchanged.
"""

import asyncio
import logging
import time

import httpx

from db import get_setting

logger = logging.getLogger(__name__)

SITES = ("rule34", "danbooru", "gelbooru")
SITE_LABELS = {"rule34": "R34", "danbooru": "Dan", "gelbooru": "Gel"}

AILAB_API = "http://127.0.0.1:17890"
DANBOORU_CRED_ID = "cred-385f3ba4"
GELBOORU_CRED_ID = "cred-633bfa3d"

MAX_429_RETRIES = 5

# Live status per site, readable by the app for /settings + dashboard.
site_status: dict = {
    s: {"auth": "unknown", "detail": "", "checked_at": 0.0} for s in SITES
}


# ── credentials ──────────────────────────────────────────────────────────────

_vault_cache: dict = {}
_VAULT_TTL = 300.0


async def _vault_credential(cred_id: str) -> dict:
    """Vault read, cached. Returns {} when the vault is unreachable — a scrape
    must degrade to anonymous, not crash, when the backend is restarting."""
    now = time.monotonic()
    hit = _vault_cache.get(cred_id)
    if hit and now - hit[1] < _VAULT_TTL:
        return hit[0]
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{AILAB_API}/api/ai/credentials/{cred_id}", params={"reveal": "1"})
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        logger.warning(f"vault read {cred_id} failed: {e}")
        data = {}
    _vault_cache[cred_id] = (data, now)
    return data


async def danbooru_credentials() -> tuple[str, str]:
    """(login, api_key) — settings override vault; either may be empty."""
    login = (await get_setting("danbooru_login") or "").strip()
    key = (await get_setting("danbooru_api_key") or "").strip()
    if login and key:
        return login, key
    cred = await _vault_credential(DANBOORU_CRED_ID)
    return (login or (cred.get("username") or "").strip(),
            key or (cred.get("tokenSecret") or "").strip())


async def gelbooru_credentials() -> tuple[str, str]:
    """(user_id, api_key) — settings override vault; either may be empty."""
    uid = (await get_setting("gelbooru_user_id") or "").strip()
    key = (await get_setting("gelbooru_api_key") or "").strip()
    if uid and key:
        return uid, key
    cred = await _vault_credential(GELBOORU_CRED_ID)
    return (uid or (cred.get("tokenId") or "").strip(),
            key or (cred.get("tokenSecret") or "").strip())


async def site_enabled(site: str) -> bool:
    """Per-site kill switch (settings '<site>_enabled', default on). rule34 has
    no switch — it is the addon's original site and its tags/keys UI."""
    if site == "rule34":
        return True
    v = await get_setting(f"{site}_enabled")
    return v is None or str(v).strip() not in ("0", "false", "off")


# ── rate limiting ────────────────────────────────────────────────────────────

class SlidingLimiter:
    """n requests per window, one per site (only ONE key exists per site, so
    there is no pool to balance — be conservative and back off on 429/5xx)."""

    def __init__(self, setting_key: str, default_per_min: int):
        self._setting_key = setting_key
        self._default = default_per_min
        self._ts: list[float] = []
        self._lock = asyncio.Lock()

    async def acquire(self):
        while True:
            async with self._lock:
                try:
                    per_min = int(await get_setting(self._setting_key) or self._default)
                except (TypeError, ValueError):
                    per_min = self._default
                now = time.monotonic()
                self._ts = [t for t in self._ts if now - t < 60.0]
                if len(self._ts) < max(1, per_min):
                    self._ts.append(now)
                    return
                wait = 60.0 - (now - self._ts[0])
            await asyncio.sleep(max(0.05, min(wait, 5.0)))


# ── rating normalisation ─────────────────────────────────────────────────────

_RATING_WORDS = {
    "g": "general", "s": "sensitive", "q": "questionable", "e": "explicit",
    # already-full words pass through (gelbooru/rule34)
    "general": "general", "sensitive": "sensitive",
    "questionable": "questionable", "explicit": "explicit", "safe": "safe",
}


def norm_rating(r) -> str:
    return _RATING_WORDS.get(str(r or "").strip().lower(), str(r or "").strip() or "unknown")


def _ext_from_url(url: str) -> str:
    from urllib.parse import urlparse
    import os as _os
    return _os.path.splitext(urlparse(url or "").path)[1].lstrip(".")


# ── danbooru ─────────────────────────────────────────────────────────────────

DANBOORU_BASE = "https://danbooru.donmai.us"
# rule34-style tokens that danbooru spells differently. Only what the watched
# tags actually need; anything unrecognised passes through unchanged.
_DAN_TAG_MAP = {
    "rating:safe": "rating:general",
    "rating:s": "rating:general",
}


def danbooru_translate(tag_query: str) -> tuple[str, list[str], bool]:
    """-> (tags string for danbooru, tags used, truncated?). Travis's rule:
    more than 2 tags -> use the FIRST TWO as listed, and the UI hints at it."""
    toks = [t.strip() for t in (tag_query or "").split() if t.strip()]
    out = []
    for t in toks:
        tl = t.lower()
        if tl in _DAN_TAG_MAP:
            out.append(_DAN_TAG_MAP[tl])
        elif tl.startswith("sort:score"):
            out.append("order:score")
        elif tl.startswith("sort:"):
            out.append("order:" + t.split(":", 1)[1].split(":")[0])
        else:
            out.append(t)
    truncated = len(out) > 2
    used = out[:2]
    return " ".join(used), used, truncated


class DanbooruClient:
    def __init__(self):
        self._client: httpx.AsyncClient | None = None
        self._limiter = SlidingLimiter("danbooru_rate_per_min", 30)
        self._auth: tuple[str, str] | None = None     # validated (login, key)
        self._auth_checked = 0.0
        self.last_api_error: dict | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=True,
                headers={"User-Agent": "AI-Lab-Booru-Scraper/1.0"})
        return self._client

    async def _auth_params(self) -> dict:
        """Validated auth params, or {} for anonymous. A bad key fails EVERY
        request with Access denied, so it must never be blindly attached."""
        now = time.monotonic()
        if now - self._auth_checked < _VAULT_TTL:
            return ({"login": self._auth[0], "api_key": self._auth[1]} if self._auth else {})
        self._auth_checked = now
        login, key = await danbooru_credentials()
        if not (login and key):
            self._auth = None
            site_status["danbooru"].update(
                auth="anonymous", checked_at=time.time(),
                detail="no login+api_key configured (vault cred-385f3ba4 or addon settings) — "
                       "anonymous limits apply")
            return {}
        try:
            await self._limiter.acquire()
            r = await self._http().get(f"{DANBOORU_BASE}/profile.json",
                                       params={"login": login, "api_key": key})
            ok = r.status_code == 200 and isinstance(r.json(), dict) and r.json().get("id")
        except Exception as e:
            logger.warning(f"danbooru auth check failed: {e}")
            ok = False
        if ok:
            self._auth = (login, key)
            site_status["danbooru"].update(auth="authenticated", checked_at=time.time(),
                                           detail=f"authenticated as {login}")
            return {"login": login, "api_key": key}
        self._auth = None
        site_status["danbooru"].update(
            auth="anonymous", checked_at=time.time(),
            detail="configured credentials were REJECTED by danbooru (profile.json: access "
                   "denied) — running anonymously; fix the api_key in the vault or settings")
        logger.warning("danbooru credentials rejected — running anonymously")
        return {}

    async def _search(self, tags: str, page_cursor: str | None, limit: int = 200) -> list[dict]:
        params: dict = {"tags": tags, "limit": str(limit)}
        if page_cursor:
            params["page"] = page_cursor
        params.update(await self._auth_params())
        for attempt in range(MAX_429_RETRIES):
            await self._limiter.acquire()
            try:
                r = await self._http().get(f"{DANBOORU_BASE}/posts.json", params=params)
                if r.status_code in (429, 500, 502, 503):
                    wait = 2 ** (attempt + 1)
                    logger.warning(f"danbooru {r.status_code} on '{tags}', waiting {wait}s")
                    await asyncio.sleep(wait)
                    continue
                r.raise_for_status()
                data = r.json()
                if isinstance(data, list):
                    self.last_api_error = None
                    return data
                # {'success': False, 'error': ..., 'message': ...} — e.g. TagLimitError
                msg = (data or {}).get("message") or (data or {}).get("error") or "unexpected response"
                self.last_api_error = {"error": f"danbooru: {msg}"[:160], "at": time.time()}
                logger.warning(f"danbooru error for '{tags}': {msg}")
                return []
            except Exception as e:
                logger.error(f"danbooru search error '{tags}': {e}")
                self.last_api_error = {"error": f"danbooru: {e}"[:160], "at": time.time()}
                return []
        self.last_api_error = {"error": "danbooru: exhausted 429/5xx retries", "at": time.time()}
        return []

    async def iter_post_pages(self, tag_query: str, since_id: int = 0, on_progress=None):
        """Yields pages of UNIFIED posts with id > since_id, newest first,
        paginated by the page=b<lowest_id> cursor (verified live)."""
        tags, _used, _trunc = danbooru_translate(tag_query)
        cursor: str | None = None
        total = 0
        while True:
            posts = await self._search(tags, cursor)
            if not posts:
                break
            new = [p for p in posts if (p.get("id") or 0) > since_id]
            unified = [u for u in (self.parse(p) for p in new) if u is not None]
            if unified:
                total += len(unified)
                if on_progress:
                    try:
                        on_progress(total)
                    except Exception:
                        pass
                yield unified
            if len(new) < len(posts):
                break
            min_id = min((p.get("id") or 0) for p in posts)
            if min_id <= since_id + 1:
                break
            cursor = f"b{min_id}"

    @staticmethod
    def parse(raw: dict) -> dict | None:
        """None for posts whose file is hidden (restricted posts omit file_url
        and sometimes md5 for anonymous users) — nothing to download."""
        file_url = raw.get("file_url") or ""
        if not raw.get("id") or not file_url:
            return None
        return {
            "site": "danbooru",
            "site_post_id": int(raw["id"]),
            "md5": (raw.get("md5") or "").lower() or None,
            "file_url": file_url,
            "preview_url": raw.get("preview_file_url"),
            "sample_url": raw.get("large_file_url"),
            "tags": raw.get("tag_string", "") or "",
            "score": raw.get("score", 0) or 0,
            "rating": norm_rating(raw.get("rating")),
            "source": raw.get("source", "") or "",
            "width": raw.get("image_width"),
            "height": raw.get("image_height"),
            "file_ext": raw.get("file_ext") or _ext_from_url(file_url),
            "file_size": raw.get("file_size"),
            "created_at": raw.get("created_at"),
        }

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()


# ── gelbooru ─────────────────────────────────────────────────────────────────

GELBOORU_BASE = "https://gelbooru.com/index.php"


class GelbooruClient:
    def __init__(self):
        self._client: httpx.AsyncClient | None = None
        self._limiter = SlidingLimiter("gelbooru_rate_per_min", 50)
        self.last_api_error: dict | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=True,
                headers={"User-Agent": "AI-Lab-Booru-Scraper/1.0"})
        return self._client

    async def _search(self, tags: str, limit: int = 100) -> list[dict]:
        params = {"page": "dapi", "s": "post", "q": "index", "json": "1",
                  "tags": tags, "limit": str(limit)}
        uid, key = await gelbooru_credentials()
        if uid and key:
            params["user_id"] = uid
            params["api_key"] = key
            if site_status["gelbooru"]["auth"] != "authenticated":
                site_status["gelbooru"].update(auth="authenticated", checked_at=time.time(),
                                               detail=f"api key for user_id {uid}")
        elif site_status["gelbooru"]["auth"] == "unknown":
            site_status["gelbooru"].update(auth="anonymous", checked_at=time.time(),
                                           detail="no user_id+api_key (vault cred-633bfa3d or settings)")
        for attempt in range(MAX_429_RETRIES):
            await self._limiter.acquire()
            try:
                r = await self._http().get(GELBOORU_BASE, params=params)
                if r.status_code in (429, 500, 502, 503):
                    wait = 2 ** (attempt + 1)
                    logger.warning(f"gelbooru {r.status_code} on '{tags}', waiting {wait}s")
                    await asyncio.sleep(wait)
                    continue
                r.raise_for_status()
                data = r.json()
                # gelbooru wraps in {"@attributes":…, "post":[…]}; "post" absent = empty.
                posts = data.get("post") if isinstance(data, dict) else data
                if posts is None:
                    posts = []
                if isinstance(posts, dict):     # single-result unwrapped object
                    posts = [posts]
                self.last_api_error = None
                return posts
            except Exception as e:
                logger.error(f"gelbooru search error '{tags}': {e}")
                self.last_api_error = {"error": f"gelbooru: {e}"[:160], "at": time.time()}
                return []
        self.last_api_error = {"error": "gelbooru: exhausted 429/5xx retries", "at": time.time()}
        return []

    async def iter_post_pages(self, tag_query: str, since_id: int = 0, on_progress=None):
        """id:<N pagination, verified live on gelbooru's dapi."""
        base_tags = (tag_query or "").strip()
        current = base_tags
        total = 0
        while True:
            posts = await self._search(current)
            if not posts:
                break
            new = [p for p in posts if (p.get("id") or 0) > since_id]
            unified = [u for u in (self.parse(p) for p in new) if u is not None]
            if unified:
                total += len(unified)
                if on_progress:
                    try:
                        on_progress(total)
                    except Exception:
                        pass
                yield unified
            if len(new) < len(posts):
                break
            if len(posts) < 100:
                break
            min_id = min((p.get("id") or 0) for p in posts)
            if min_id <= since_id + 1:
                break
            current = f"{base_tags} id:<{min_id}"

    @staticmethod
    def parse(raw: dict) -> dict | None:
        file_url = raw.get("file_url") or ""
        if not raw.get("id") or not file_url:
            return None
        return {
            "site": "gelbooru",
            "site_post_id": int(raw["id"]),
            "md5": (raw.get("md5") or "").lower() or None,
            "file_url": file_url,
            "preview_url": raw.get("preview_url"),
            "sample_url": raw.get("sample_url") or None,
            "tags": raw.get("tags", "") or "",
            "score": raw.get("score", 0) or 0,
            "rating": norm_rating(raw.get("rating")),
            "source": raw.get("source", "") or "",
            "width": raw.get("width"),
            "height": raw.get("height"),
            "file_ext": _ext_from_url(file_url),
            "file_size": None,
            "created_at": raw.get("created_at"),
        }

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()


# ── rule34 adapter ───────────────────────────────────────────────────────────

class Rule34Adapter:
    """Wraps the existing scraper.Rule34Client (key pool, proxies, id:< walk)
    behind the same unified-page interface. The rule34 dapi exposes the file
    md5 as 'hash'."""

    def __init__(self, client):
        self.client = client

    @property
    def last_api_error(self):
        return self.client.last_api_error

    async def iter_post_pages(self, tag_query: str, since_id: int = 0, on_progress=None):
        from scraper import parse_post
        async for page in self.client.iter_post_pages(tag_query, since_id=since_id,
                                                      on_progress=on_progress):
            unified = []
            for raw in page:
                p = parse_post(raw)
                if p["id"] is None:
                    continue
                unified.append({
                    "site": "rule34",
                    "site_post_id": int(p["id"]),
                    "md5": (raw.get("hash") or "").lower() or None,
                    "file_url": p["file_url"],
                    "preview_url": p.get("preview_url"),
                    "sample_url": p.get("sample_url"),
                    "tags": p.get("tags", ""),
                    "score": p.get("score", 0),
                    "rating": norm_rating(p.get("rating")),
                    "source": p.get("source", ""),
                    "width": p.get("width"),
                    "height": p.get("height"),
                    "file_ext": p.get("file_ext"),
                    "file_size": p.get("file_size"),
                    "created_at": p.get("created_at"),
                })
            if unified:
                yield unified
