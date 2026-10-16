"""SQLite schema and helpers for the Pixiv scraper addon.

Modeled on addons/rule34/db.py but single-site, so the pixiv illust id is the
natural primary key. One illust = N pages (manga posts), so downloads are
tracked per PAGE and an illust counts downloaded only when every page is.
"""

import aiosqlite
import asyncio
import os
import time
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "state.db")

_BROWSE_CACHE: dict = {}
_BROWSE_TTL = 120.0

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS illusts (
    id INTEGER PRIMARY KEY,
    title TEXT DEFAULT '',
    type TEXT DEFAULT 'illust',
    artist_id INTEGER,
    artist_name TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    tags_flat TEXT DEFAULT '',
    x_restrict INTEGER DEFAULT 0,
    page_count INTEGER DEFAULT 1,
    width INTEGER, height INTEGER,
    bookmarks INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    create_date TEXT,
    scraped_at TEXT NOT NULL,
    downloaded INTEGER DEFAULT 0,
    download_error TEXT,
    download_attempts INTEGER DEFAULT 0,
    next_retry_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pages (
    illust_id INTEGER NOT NULL REFERENCES illusts(id),
    page_no INTEGER NOT NULL,
    url TEXT NOT NULL,
    preview_url TEXT,
    local_path TEXT,
    downloaded INTEGER DEFAULT 0,
    PRIMARY KEY (illust_id, page_no)
);

CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('tag', 'artist')),
    value TEXT NOT NULL,
    label TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    added_at TEXT NOT NULL,
    last_scraped_at TEXT,
    last_illust_id INTEGER DEFAULT 0,
    UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS watch_illusts (
    watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    illust_id INTEGER NOT NULL REFERENCES illusts(id),
    PRIMARY KEY (watch_id, illust_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_illusts_downloaded ON illusts(downloaded);
CREATE INDEX IF NOT EXISTS idx_illusts_artist ON illusts(artist_id);
CREATE INDEX IF NOT EXISTS idx_pages_dl ON pages(downloaded);
CREATE INDEX IF NOT EXISTS idx_wi_illust ON watch_illusts(illust_id);
"""

DEFAULT_SETTINGS = {
    "storage_path": "/nas/zpoolalpha/media/xxx/pixiv",
    "poll_interval_sec": "3600",
    "download_concurrency": "2",
    # Seconds between pixiv API calls — Travis's real account rides on this
    # being polite. Downloads (i.pximg.net CDN) share the same floor.
    "pixiv_min_interval_sec": "1.2",
    # Vault credential id holding the OAuth REFRESH TOKEN (tokenSecret field).
    # The settings key pixiv_refresh_token, if set, overrides the vault.
    "pixiv_token_cred_id": "",
}


def retry_on_locked(fn):
    async def _wrapper(*args, **kwargs):
        for attempt in range(6):
            try:
                return await fn(*args, **kwargs)
            except Exception as e:
                if "locked" in str(e).lower() and attempt < 5:
                    await asyncio.sleep(0.25 * (attempt + 1))
                    continue
                raise
    return _wrapper


async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA busy_timeout=45000")
    await db.execute("PRAGMA foreign_keys=ON")
    return db


async def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = await get_db()
    try:
        await db.executescript(SCHEMA_SQL)
        for key, value in DEFAULT_SETTINGS.items():
            await db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))
        await db.commit()
    finally:
        await db.close()


async def get_setting(key: str) -> str | None:
    db = await get_db()
    try:
        cur = await db.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = await cur.fetchone()
        return row["value"] if row else None
    finally:
        await db.close()


async def get_all_settings() -> dict:
    db = await get_db()
    try:
        cur = await db.execute("SELECT key, value FROM settings")
        return {r["key"]: r["value"] for r in await cur.fetchall()}
    finally:
        await db.close()


@retry_on_locked
async def update_settings(updates: dict):
    db = await get_db()
    try:
        for k, v in updates.items():
            await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, str(v)))
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def upsert_illust(il: dict) -> bool:
    """Insert an illust + its pages. Returns True when newly inserted."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT id FROM illusts WHERE id = ?", (il["id"],))
        if await cur.fetchone():
            # Volatile facts only — bookmark/view counts drift upward.
            await db.execute(
                "UPDATE illusts SET bookmarks = ?, views = ? WHERE id = ?",
                (il.get("bookmarks", 0), il.get("views", 0), il["id"]))
            await db.commit()
            return False
        await db.execute(
            """INSERT INTO illusts (id, title, type, artist_id, artist_name, tags, tags_flat,
               x_restrict, page_count, width, height, bookmarks, views, create_date, scraped_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (il["id"], il.get("title", ""), il.get("type", "illust"),
             il.get("artist_id"), il.get("artist_name", ""),
             il.get("tags", "[]"), il.get("tags_flat", ""),
             il.get("x_restrict", 0), il.get("page_count", 1),
             il.get("width"), il.get("height"),
             il.get("bookmarks", 0), il.get("views", 0),
             il.get("create_date"), datetime.now(timezone.utc).isoformat()))
        await db.executemany(
            "INSERT OR IGNORE INTO pages (illust_id, page_no, url, preview_url) VALUES (?, ?, ?, ?)",
            [(il["id"], p["page_no"], p["url"], p.get("preview_url")) for p in il.get("pages", [])])
        await db.commit()
        return True
    finally:
        await db.close()


@retry_on_locked
async def link_watch(watch_id: int, illust_ids: list[int]):
    if not illust_ids:
        return
    db = await get_db()
    try:
        await db.executemany(
            "INSERT OR IGNORE INTO watch_illusts (watch_id, illust_id) VALUES (?, ?)",
            [(watch_id, i) for i in illust_ids])
        await db.commit()
    finally:
        await db.close()


async def get_watches() -> list[dict]:
    db = await get_db()
    try:
        cur = await db.execute("""
            SELECT w.*, COUNT(wi.illust_id) AS live_total,
                   SUM(CASE WHEN i.downloaded = 1 THEN 1 ELSE 0 END) AS live_downloaded,
                   SUM(CASE WHEN i.downloaded = -1 THEN 1 ELSE 0 END) AS live_failed
            FROM watches w
            LEFT JOIN watch_illusts wi ON wi.watch_id = w.id
            LEFT JOIN illusts i ON i.id = wi.illust_id
            GROUP BY w.id ORDER BY w.id""")
        return [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


@retry_on_locked
async def add_watch(kind: str, value: str, label: str = "") -> int:
    db = await get_db()
    try:
        cur = await db.execute(
            "INSERT OR IGNORE INTO watches (kind, value, label, added_at) VALUES (?, ?, ?, ?)",
            (kind, value.strip(), label.strip(), datetime.now(timezone.utc).isoformat()))
        await db.commit()
        return cur.lastrowid or 0
    finally:
        await db.close()


@retry_on_locked
async def remove_watch(watch_id: int):
    db = await get_db()
    try:
        await db.execute("DELETE FROM watch_illusts WHERE watch_id = ?", (watch_id,))
        await db.execute("DELETE FROM watches WHERE id = ?", (watch_id,))
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def toggle_watch(watch_id: int, enabled: bool):
    db = await get_db()
    try:
        await db.execute("UPDATE watches SET enabled = ? WHERE id = ?", (1 if enabled else 0, watch_id))
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def update_watch_progress(watch_id: int, last_illust_id: int):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE watches SET last_scraped_at = ?, last_illust_id = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), last_illust_id, watch_id))
        await db.commit()
    finally:
        await db.close()


async def get_pending_page_downloads(limit: int = 30) -> list[dict]:
    """Pages still to download, for illusts not failed and not in backoff."""
    db = await get_db()
    try:
        cur = await db.execute(
            """SELECT p.illust_id, p.page_no, p.url, i.artist_id, i.download_attempts
               FROM pages p JOIN illusts i ON i.id = p.illust_id
               WHERE p.downloaded = 0 AND i.downloaded = 0
                 AND (i.next_retry_at IS NULL OR i.next_retry_at <= CAST(strftime('%s','now') AS INTEGER))
               ORDER BY p.illust_id DESC, p.page_no LIMIT ?""", (limit,))
        return [dict(r) for r in await cur.fetchall()]
    finally:
        await db.close()


@retry_on_locked
async def mark_page_downloaded(illust_id: int, page_no: int, local_path: str):
    """Mark one page done; when it was the last, the illust flips downloaded."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE pages SET downloaded = 1, local_path = ? WHERE illust_id = ? AND page_no = ?",
            (local_path, illust_id, page_no))
        await db.execute(
            "UPDATE illusts SET downloaded = 1, download_error = NULL WHERE id = ? AND NOT EXISTS "
            "(SELECT 1 FROM pages WHERE illust_id = ? AND downloaded = 0)",
            (illust_id, illust_id))
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def mark_illust_failed(illust_id: int, error: str, permanent: bool = False):
    db = await get_db()
    try:
        if permanent:
            await db.execute(
                "UPDATE illusts SET downloaded = -1, download_error = ? WHERE id = ?",
                (error, illust_id))
        else:
            cur = await db.execute("SELECT download_attempts FROM illusts WHERE id = ?", (illust_id,))
            row = await cur.fetchone()
            attempts = (row["download_attempts"] if row else 0) + 1
            if attempts >= 8:
                await db.execute(
                    "UPDATE illusts SET downloaded = -1, download_error = ? WHERE id = ?",
                    (f"gave up after {attempts} tries: {error}", illust_id))
            else:
                delay = min(30 * (2 ** (attempts - 1)), 1800)
                await db.execute(
                    "UPDATE illusts SET download_error = ?, download_attempts = ?, next_retry_at = ? WHERE id = ?",
                    (error, attempts, int(time.time()) + delay, illust_id))
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def retry_failed():
    db = await get_db()
    try:
        await db.execute(
            "UPDATE illusts SET downloaded = 0, download_error = NULL, download_attempts = 0, "
            "next_retry_at = 0 WHERE downloaded = -1")
        await db.commit()
    finally:
        await db.close()


async def get_stats() -> dict:
    db = await get_db()
    try:
        cur = await db.execute("SELECT downloaded, COUNT(*) c FROM illusts GROUP BY downloaded")
        by = {r["downloaded"]: r["c"] for r in await cur.fetchall()}
        cur = await db.execute("SELECT COUNT(*) c FROM pages WHERE downloaded = 1")
        pages_dl = (await cur.fetchone())["c"]
        cur = await db.execute("SELECT COUNT(DISTINCT artist_id) c FROM illusts")
        artists = (await cur.fetchone())["c"]
        return {
            "total_illusts": sum(by.values()),
            "downloaded": by.get(1, 0),
            "pending": by.get(0, 0),
            "failed": by.get(-1, 0),
            "pages_downloaded": pages_dl,
            "artists": artists,
        }
    finally:
        await db.close()


async def browse_illusts(q: str | None = None, page: int = 1, per_page: int = 40,
                         sort: str = "newest", artist_id: int | None = None,
                         restrict: str | None = None) -> tuple[list[dict], int]:
    db = await get_db()
    try:
        conds, params = [], []
        if q:
            for tok in q.lower().split():
                conds.append("(i.tags_flat LIKE ? OR lower(i.title) LIKE ? OR lower(i.artist_name) LIKE ?)")
                params.extend([f"%{tok}%"] * 3)
        if artist_id:
            conds.append("i.artist_id = ?")
            params.append(artist_id)
        if restrict == "r18":
            conds.append("i.x_restrict >= 1")
        elif restrict == "all-ages":
            conds.append("i.x_restrict = 0")
        where = "WHERE " + " AND ".join(conds) if conds else ""
        order = {"newest": "i.id DESC", "bookmarks": "i.bookmarks DESC",
                 "views": "i.views DESC"}.get(sort, "i.id DESC")
        ck = (q or "", artist_id or 0, restrict or "", sort)
        now = time.monotonic()
        hit = _BROWSE_CACHE.get(ck)
        if hit and now - hit[1] < _BROWSE_TTL:
            total = hit[0]
        else:
            cur = await db.execute(f"SELECT COUNT(*) c FROM illusts i {where}", params)
            total = (await cur.fetchone())["c"]
            _BROWSE_CACHE[ck] = (total, now)
        cur = await db.execute(
            f"SELECT i.* FROM illusts i {where} ORDER BY {order} LIMIT ? OFFSET ?",
            params + [per_page, (page - 1) * per_page])
        return [dict(r) for r in await cur.fetchall()], total
    finally:
        await db.close()


async def get_illust(illust_id: int) -> dict | None:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM illusts WHERE id = ?", (illust_id,))
        row = await cur.fetchone()
        if not row:
            return None
        il = dict(row)
        cur = await db.execute(
            "SELECT page_no, url, preview_url, local_path, downloaded FROM pages "
            "WHERE illust_id = ? ORDER BY page_no", (illust_id,))
        il["pages"] = [dict(r) for r in await cur.fetchall()]
        return il
    finally:
        await db.close()
