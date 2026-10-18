"""SQLite schema, migrations, and query helpers for Rule34 scraper addon."""

import aiosqlite
import asyncio
import os
import time
from datetime import datetime, timezone

# Cache of per-watched-tag live download counts, refreshed by a background loop
# so request handlers never pay the heavy junction-table aggregation.
_WT_AGG: dict = {"data": {}, "ts": 0.0}

# Per-filter total-count cache for browse pagination — page turns reuse the
# total instead of recomputing a COUNT(*) over the tag-filtered set each time.
_BROWSE_COUNT: dict = {}
_BROWSE_COUNT_TTL = 120.0
# Ordered matching-id list per tag-filtered query, so page turns slice an
# in-memory list instead of re-running the tag-match each time.
_BROWSE_IDS: dict = {}

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "state.db")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    file_url TEXT NOT NULL,
    preview_url TEXT,
    sample_url TEXT,
    tags TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    rating TEXT,
    source TEXT,
    width INTEGER,
    height INTEGER,
    file_ext TEXT,
    file_size INTEGER,
    created_at TEXT,
    scraped_at TEXT NOT NULL,
    downloaded INTEGER DEFAULT 0,
    local_path TEXT,
    download_error TEXT,
    download_attempts INTEGER DEFAULT 0,
    next_retry_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    post_count INTEGER DEFAULT 0,
    tag_type INTEGER DEFAULT 0,
    type_fetched INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS post_tags (
    post_id INTEGER NOT NULL REFERENCES posts(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE IF NOT EXISTS watched_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_query TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    added_at TEXT NOT NULL,
    last_scraped_at TEXT,
    last_post_id INTEGER DEFAULT 0,
    total_found INTEGER DEFAULT 0,
    total_downloaded INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watched_tag_posts (
    watched_tag_id INTEGER NOT NULL REFERENCES watched_tags(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    PRIMARY KEY (watched_tag_id, post_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    label TEXT DEFAULT '',
    proxy TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_downloaded ON posts(downloaded);
CREATE INDEX IF NOT EXISTS idx_posts_file_url ON posts(file_url);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag_id ON post_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_wtp_post_id ON watched_tag_posts(post_id);
"""

DEFAULT_SETTINGS = {
    "api_key": "aa0e5123cc7e108619e5cc0c09ced59c0f61b43739c107e6f755028a3428a18ebd38ef3c6a854daca40a059563776218cea3ad511677207261474df2e9ddba87",
    "user_id": "6239530",
    "storage_path": "/nas/zpoolalpha/media/xxx/rule34",
    "poll_interval_sec": "3600",
    "download_concurrency": "3",
    "rate_limit_rps": "1",
    "max_retries": "3",
    # Global download bandwidth cap in KB/s across all concurrent downloads
    # (0 = unlimited). Lets you throttle the scraper so it can't saturate the link.
    "download_bandwidth_limit_kbps": "0",
    # Per-key API rate limit (the pool enforces this window PER key and
    # round-robins across enabled keys, so effective ceiling = N * requests).
    "rate_limit_requests": "60",
    "rate_limit_window_sec": "60",
}


def retry_on_locked(fn):
    """Retry a write coroutine when SQLite reports 'database is locked' (WAL write
    contention between the scrape / download / tag-type loops). busy_timeout handles
    short waits; this covers the rare case a write is starved past it."""
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
        # Defensive: add the proxy column if an older api_keys table predates it.
        cursor = await db.execute("PRAGMA table_info(api_keys)")
        cols = {r["name"] for r in await cursor.fetchall()}
        if "proxy" not in cols:
            await db.execute("ALTER TABLE api_keys ADD COLUMN proxy TEXT DEFAULT ''")
        # Defensive: add type_fetched to tags (for the tag-typing backfill).
        cursor = await db.execute("PRAGMA table_info(tags)")
        tcols = {r["name"] for r in await cursor.fetchall()}
        if "type_fetched" not in tcols:
            await db.execute("ALTER TABLE tags ADD COLUMN type_fetched INTEGER DEFAULT 0")
        # Defensive: add download retry bookkeeping to posts (auto-requeue of
        # transient download failures + backoff scheduling).
        cursor = await db.execute("PRAGMA table_info(posts)")
        pcols = {r["name"] for r in await cursor.fetchall()}
        if "download_attempts" not in pcols:
            await db.execute("ALTER TABLE posts ADD COLUMN download_attempts INTEGER DEFAULT 0")
        if "next_retry_at" not in pcols:
            await db.execute("ALTER TABLE posts ADD COLUMN next_retry_at INTEGER DEFAULT 0")
        # ── multi-site migration (2026-10-16) ─────────────────────────────────
        # posts.id becomes an INTERNAL id. Pre-migration rows ARE rule34 posts
        # whose internal id equals the site post id, so site_post_id is
        # backfilled from id; new rows (any site, rule34 included) take fresh
        # rowids above MAX(id) and carry their site id in site_post_id — the
        # two id spaces can never collide because explicit ids are never
        # inserted again. (site, site_post_id) is the natural key.
        if "site" not in pcols:
            await db.execute("ALTER TABLE posts ADD COLUMN site TEXT NOT NULL DEFAULT 'rule34'")
        if "site_post_id" not in pcols:
            await db.execute("ALTER TABLE posts ADD COLUMN site_post_id INTEGER")
            await db.execute("UPDATE posts SET site_post_id = id WHERE site_post_id IS NULL")
        if "md5" not in pcols:
            # Existing rows have no md5 (the dapi 'hash' was never stored);
            # upsert backfills it the next time a scrape sees the post. NULL
            # md5 = "identity unknown", which dedups as itself only.
            await db.execute("ALTER TABLE posts ADD COLUMN md5 TEXT")
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_posts_site_sid ON posts(site, site_post_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_posts_md5 ON posts(md5)")
        # One downloaded FILE per md5, whichever site supplied it first. posts
        # reference it by md5; a cross-posted image downloads once.
        await db.execute("""CREATE TABLE IF NOT EXISTS media_files (
            md5 TEXT PRIMARY KEY,
            local_path TEXT NOT NULL,
            file_size INTEGER,
            first_site TEXT,
            downloaded_at TEXT
        )""")
        # Per-(watched tag, site) scrape cursor — each site has its own id
        # space, so one last_post_id cannot serve three sites. The legacy
        # watched_tags.last_post_id seeds the rule34 cursor and keeps being
        # written for it (older UI fields read it).
        await db.execute("""CREATE TABLE IF NOT EXISTS watched_tag_cursors (
            watched_tag_id INTEGER NOT NULL REFERENCES watched_tags(id) ON DELETE CASCADE,
            site TEXT NOT NULL,
            last_post_id INTEGER DEFAULT 0,
            last_scraped_at TEXT,
            PRIMARY KEY (watched_tag_id, site)
        )""")
        await db.execute(
            "INSERT OR IGNORE INTO watched_tag_cursors (watched_tag_id, site, last_post_id, last_scraped_at) "
            "SELECT id, 'rule34', last_post_id, last_scraped_at FROM watched_tags")
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_tags_untyped ON tags(type_fetched, post_count)"
        )
        for key, value in DEFAULT_SETTINGS.items():
            await db.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (key, value),
            )
        # Migrate the legacy single api_key/user_id into the api_keys pool.
        cursor = await db.execute("SELECT COUNT(*) AS n FROM api_keys")
        row = await cursor.fetchone()
        if row["n"] == 0:
            c2 = await db.execute("SELECT value FROM settings WHERE key = 'api_key'")
            r2 = await c2.fetchone()
            legacy_key = r2["value"] if r2 else None
            c3 = await db.execute("SELECT value FROM settings WHERE key = 'user_id'")
            r3 = await c3.fetchone()
            legacy_uid = r3["value"] if r3 else None
            if legacy_key and legacy_uid:
                await db.execute(
                    "INSERT INTO api_keys (api_key, user_id, label, enabled, added_at) "
                    "VALUES (?, ?, 'primary', 1, ?)",
                    (legacy_key, legacy_uid, datetime.now(timezone.utc).isoformat()),
                )
        await db.commit()
    finally:
        await db.close()


async def get_setting(key: str) -> str | None:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = await cursor.fetchone()
        return row["value"] if row else None
    finally:
        await db.close()


async def get_all_settings() -> dict:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT key, value FROM settings")
        rows = await cursor.fetchall()
        return {row["key"]: row["value"] for row in rows}
    finally:
        await db.close()


@retry_on_locked
async def update_settings(updates: dict):
    db = await get_db()
    try:
        for key, value in updates.items():
            await db.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, str(value)),
            )
        await db.commit()
    finally:
        await db.close()


# --- API key pool ---------------------------------------------------------

async def list_api_keys() -> list[dict]:
    """All API keys with a masked key preview for display."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id, api_key, user_id, label, proxy, enabled FROM api_keys ORDER BY id"
        )
        rows = await cursor.fetchall()
        out = []
        for r in rows:
            k = r["api_key"] or ""
            preview = (k[:6] + "…" + k[-4:]) if len(k) > 12 else "…"
            out.append({
                "id": r["id"],
                "key_preview": preview,
                "user_id": r["user_id"],
                "label": r["label"] or "",
                "proxy": r["proxy"] or "",
                "enabled": bool(r["enabled"]),
            })
        return out
    finally:
        await db.close()


async def get_enabled_api_keys() -> list[dict]:
    """Full credentials for enabled keys — used by the request pool only."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id, api_key, user_id, proxy FROM api_keys WHERE enabled = 1 ORDER BY id"
        )
        rows = await cursor.fetchall()
        return [
            {"id": r["id"], "api_key": r["api_key"], "user_id": r["user_id"],
             "proxy": r["proxy"] or ""}
            for r in rows
        ]
    finally:
        await db.close()


@retry_on_locked
async def add_api_key(api_key: str, user_id: str, label: str = "", proxy: str = "") -> int:
    db = await get_db()
    try:
        cursor = await db.execute(
            "INSERT INTO api_keys (api_key, user_id, label, proxy, enabled, added_at) "
            "VALUES (?, ?, ?, ?, 1, ?)",
            (api_key.strip(), user_id.strip(), label.strip(), proxy.strip(),
             datetime.now(timezone.utc).isoformat()),
        )
        await db.commit()
        return cursor.lastrowid
    finally:
        await db.close()


@retry_on_locked
async def remove_api_key(key_id: int):
    db = await get_db()
    try:
        await db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def set_api_key_enabled(key_id: int, enabled: bool):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE api_keys SET enabled = ? WHERE id = ?", (1 if enabled else 0, key_id)
        )
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def upsert_post(post: dict) -> tuple[int, bool]:
    """Insert a post keyed on (site, site_post_id); returns (internal_id, inserted).

    Internal ids are assigned by SQLite (rowid), never taken from the site —
    pre-migration rule34 rows already occupy their own site-id values and the
    three sites' id spaces overlap. On an existing row only the volatile facts
    are refreshed (md5 backfill, url/score) — tags/rating stay as scraped."""
    site = post.get("site", "rule34")
    sid = int(post["site_post_id"])
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT id, md5 FROM posts WHERE site = ? AND site_post_id = ?", (site, sid))
        row = await cur.fetchone()
        if row:
            if post.get("md5") and not row["md5"]:
                await db.execute(
                    "UPDATE posts SET md5 = ?, file_url = ?, score = ? WHERE id = ?",
                    (post["md5"], post["file_url"], post.get("score", 0), row["id"]))
                await db.commit()
            return row["id"], False
        cursor = await db.execute(
            """INSERT INTO posts
               (site, site_post_id, md5, file_url, preview_url, sample_url, tags, score,
                rating, source, width, height, file_ext, file_size, created_at, scraped_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                site,
                sid,
                post.get("md5"),
                post["file_url"],
                post.get("preview_url"),
                post.get("sample_url"),
                post.get("tags", ""),
                post.get("score", 0),
                post.get("rating"),
                post.get("source"),
                post.get("width"),
                post.get("height"),
                post.get("file_ext"),
                post.get("file_size"),
                post.get("created_at"),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        internal_id = cursor.lastrowid
        await db.commit()
        return internal_id, True
    finally:
        await db.close()


async def find_media_by_md5(md5: str) -> dict | None:
    """The already-downloaded file for an md5, or None. Dedup's read side."""
    if not md5:
        return None
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM media_files WHERE md5 = ?", (md5,))
        row = await cur.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


@retry_on_locked
async def record_media_file(md5: str, local_path: str, file_size: int | None, site: str):
    """Register a downloaded file under its md5 (first writer wins — the bytes
    are identical by definition, so a second copy is never an improvement)."""
    if not md5:
        return
    db = await get_db()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO media_files (md5, local_path, file_size, first_site, downloaded_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (md5, local_path, file_size, site, datetime.now(timezone.utc).isoformat()))
        await db.commit()
    finally:
        await db.close()


async def get_sources_for_md5s(md5s: list[str]) -> dict:
    """{md5: [{site, site_post_id, post_id, downloaded}]} across ALL sites —
    badges always show every site an image exists on, independent of the
    browse filter (a deduped image is hidden only when ALL its sites are
    toggled off, which the filter handles; the badges stay complete)."""
    out: dict = {}
    md5s = [m for m in md5s if m]
    if not md5s:
        return out
    db = await get_db()
    try:
        CH = 500
        for i in range(0, len(md5s), CH):
            chunk = md5s[i:i + CH]
            ph = ",".join("?" * len(chunk))
            cur = await db.execute(
                f"SELECT md5, site, site_post_id, id, downloaded FROM posts WHERE md5 IN ({ph}) "
                f"ORDER BY site", chunk)
            for r in await cur.fetchall():
                out.setdefault(r["md5"], []).append({
                    "site": r["site"], "site_post_id": r["site_post_id"],
                    "post_id": r["id"], "downloaded": r["downloaded"]})
        return out
    finally:
        await db.close()


async def get_watched_tag_cursors(tag_id: int) -> dict:
    """{site: last_post_id} for a watched tag (missing site -> 0)."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT site, last_post_id FROM watched_tag_cursors WHERE watched_tag_id = ?",
            (tag_id,))
        return {r["site"]: r["last_post_id"] or 0 for r in await cur.fetchall()}
    finally:
        await db.close()


@retry_on_locked
async def update_watched_tag_cursor(tag_id: int, site: str, last_post_id: int):
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO watched_tag_cursors (watched_tag_id, site, last_post_id, last_scraped_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(watched_tag_id, site) DO UPDATE SET "
            "last_post_id = excluded.last_post_id, last_scraped_at = excluded.last_scraped_at",
            (tag_id, site, last_post_id, datetime.now(timezone.utc).isoformat()))
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def upsert_tags_for_post(post_id: int, tag_string: str):
    """Parse space-separated tags, upsert into tags table, link via post_tags."""
    tag_names = [t.strip() for t in tag_string.split() if t.strip()]
    if not tag_names:
        return
    db = await get_db()
    try:
        for name in tag_names:
            await db.execute(
                "INSERT OR IGNORE INTO tags (name, post_count) VALUES (?, 0)", (name,)
            )
            cursor = await db.execute("SELECT id FROM tags WHERE name = ?", (name,))
            row = await cursor.fetchone()
            tag_id = row["id"]
            await db.execute(
                "INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)",
                (post_id, tag_id),
            )
        # Update post counts
        await db.execute(
            """UPDATE tags SET post_count = (
                SELECT COUNT(*) FROM post_tags WHERE tag_id = tags.id
            ) WHERE name IN ({})""".format(",".join("?" * len(tag_names))),
            tag_names,
        )
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def link_posts_to_watched_tag(watched_tag_id: int, post_ids: list[int]):
    """Record which posts belong to a watched tag (for live progress tracking)."""
    if not post_ids:
        return
    db = await get_db()
    try:
        for i in range(0, len(post_ids), 2000):
            chunk = post_ids[i:i + 2000]
            await db.executemany(
                "INSERT OR IGNORE INTO watched_tag_posts (watched_tag_id, post_id) VALUES (?, ?)",
                [(watched_tag_id, pid) for pid in chunk],
            )
            await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def mark_for_redownload(post_id: int):
    """Reset a post to pending so the download loop re-fetches it (used when its
    local file is found missing/empty at view time)."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE posts SET downloaded = 0, next_retry_at = 0 WHERE id = ? AND downloaded = 1",
            (post_id,),
        )
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def backfill_watched_tag_links() -> int:
    """Link posts already in the DB to every watched tag they match (AND
    semantics), filling historical gaps where posts were downloaded before
    incremental linking existed. Idempotent (INSERT OR IGNORE). Returns the
    number of (tag,post) links examined."""
    db = await get_db()
    try:
        cur = await db.execute("SELECT id, tag_query FROM watched_tags")
        watched = [(r["id"], r["tag_query"]) for r in await cur.fetchall()]
        linked = 0
        for wid, query in watched:
            names = [t.strip() for t in (query or "").split() if t.strip()]
            if not names:
                continue
            ph = ",".join("?" * len(names))
            cur = await db.execute(f"SELECT id FROM tags WHERE name IN ({ph})", names)
            tag_ids = [r["id"] for r in await cur.fetchall()]
            if len(tag_ids) != len(names):
                continue  # some tag unknown locally -> no local post matches all
            tph = ",".join("?" * len(tag_ids))
            cur = await db.execute(
                f"SELECT pt.post_id FROM post_tags pt WHERE pt.tag_id IN ({tph}) "
                f"GROUP BY pt.post_id HAVING COUNT(DISTINCT pt.tag_id) = ?",
                tag_ids + [len(tag_ids)],
            )
            post_ids = [r["post_id"] for r in await cur.fetchall()]
            for i in range(0, len(post_ids), 2000):
                chunk = post_ids[i:i + 2000]
                await db.executemany(
                    "INSERT OR IGNORE INTO watched_tag_posts (watched_tag_id, post_id) VALUES (?, ?)",
                    [(wid, pid) for pid in chunk],
                )
                await db.commit()
            linked += len(post_ids)
        return linked
    finally:
        await db.close()


async def get_pending_downloads(limit: int = 50) -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM posts WHERE downloaded = 0 "
            "AND (next_retry_at IS NULL "
            "OR next_retry_at <= CAST(strftime('%s','now') AS INTEGER)) "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()


async def get_pending_downloads_for_tag(watched_tag_id: int, limit: int = 50) -> list[dict]:
    """Pending downloads restricted to one watched tag (via the junction), newest first.
    Powers Sync-Now download prioritization."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT p.* FROM posts p "
            "JOIN watched_tag_posts wtp ON wtp.post_id = p.id "
            "WHERE wtp.watched_tag_id = ? AND p.downloaded = 0 "
            "AND (p.next_retry_at IS NULL "
            "OR p.next_retry_at <= CAST(strftime('%s','now') AS INTEGER)) "
            "ORDER BY p.id DESC LIMIT ?",
            (watched_tag_id, limit),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()


@retry_on_locked
async def mark_downloaded(post_id: int, local_path: str):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE posts SET downloaded = 1, local_path = ? WHERE id = ?",
            (local_path, post_id),
        )
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def mark_download_failed(post_id: int, error: str):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE posts SET downloaded = -1, download_error = ? WHERE id = ?",
            (error, post_id),
        )
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def requeue_download(post_id: int, error: str, attempts: int, next_retry_at: int):
    """Put a transiently-failed post back in the queue (downloaded=0) with a
    backoff timestamp, the incremented attempt count, and the recorded reason.
    The download loop skips it until next_retry_at passes."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE posts SET downloaded = 0, download_error = ?, "
            "download_attempts = ?, next_retry_at = ? WHERE id = ?",
            (error, attempts, next_retry_at, post_id),
        )
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def retry_failed_downloads():
    """Manual retry: requeue ALL terminally-failed posts with a clean slate."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE posts SET downloaded = 0, download_error = NULL, "
            "download_attempts = 0, next_retry_at = 0 WHERE downloaded = -1"
        )
        await db.commit()
    finally:
        await db.close()


async def refresh_watched_agg() -> dict:
    """Recompute per-watched-tag live download counts (the heavy join over the
    junction table). Meant to run in a BACKGROUND loop; result is cached so
    request handlers never block on it."""
    db = await get_db()
    try:
        cursor = await db.execute("""
            SELECT wtp.watched_tag_id AS wid,
                   COUNT(*) AS live_total,
                   SUM(CASE WHEN p.downloaded = 1 THEN 1 ELSE 0 END) AS live_downloaded,
                   SUM(CASE WHEN p.downloaded = 0 THEN 1 ELSE 0 END) AS live_pending,
                   SUM(CASE WHEN p.downloaded = -1 THEN 1 ELSE 0 END) AS live_failed
            FROM watched_tag_posts wtp
            JOIN posts p ON p.id = wtp.post_id
            GROUP BY wtp.watched_tag_id
        """)
        agg = {r["wid"]: dict(r) for r in await cursor.fetchall()}
        _WT_AGG["data"] = agg
        _WT_AGG["ts"] = time.monotonic()
        return agg
    finally:
        await db.close()


async def get_watched_tags() -> list[dict]:
    """Watched tags with live download progress. Never blocks on the heavy
    aggregation — serves the last cached counts (refreshed in the background by
    the worker). The tag LIST itself is always fresh, so add/remove reflect
    immediately (new tags read 0 counts until the next background refresh)."""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM watched_tags ORDER BY id")
        rows = [dict(r) for r in await cursor.fetchall()]
    finally:
        await db.close()
    agg = _WT_AGG["data"]
    for r in rows:
        a = agg.get(r["id"], {})
        r["live_total"] = a.get("live_total", 0) or 0
        r["live_downloaded"] = a.get("live_downloaded", 0) or 0
        r["live_pending"] = a.get("live_pending", 0) or 0
        r["live_failed"] = a.get("live_failed", 0) or 0
    return rows


async def get_watched_tag_names() -> list[str]:
    """Cheap: just the watched tag_query strings (no counts join)."""
    db = await get_db()
    try:
        cursor = await db.execute("SELECT tag_query FROM watched_tags ORDER BY id")
        return [r["tag_query"] for r in await cursor.fetchall()]
    finally:
        await db.close()


@retry_on_locked
async def add_watched_tag(query: str) -> int:
    db = await get_db()
    try:
        cursor = await db.execute(
            "INSERT OR IGNORE INTO watched_tags (tag_query, added_at) VALUES (?, ?)",
            (query, datetime.now(timezone.utc).isoformat()),
        )
        await db.commit()
        return cursor.lastrowid or 0
    finally:
        await db.close()


@retry_on_locked
async def remove_watched_tag(tag_id: int):
    db = await get_db()
    try:
        await db.execute("DELETE FROM watched_tag_posts WHERE watched_tag_id = ?", (tag_id,))
        await db.execute("DELETE FROM watched_tags WHERE id = ?", (tag_id,))
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def toggle_watched_tag(tag_id: int, enabled: bool):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE watched_tags SET enabled = ? WHERE id = ?",
            (1 if enabled else 0, tag_id),
        )
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def update_watched_tag_progress(tag_id: int, last_post_id: int):
    """Update scrape metadata (last_scraped_at, last_post_id). Live counts come from junction table."""
    db = await get_db()
    try:
        await db.execute(
            """UPDATE watched_tags SET last_scraped_at = ?, last_post_id = ? WHERE id = ?""",
            (datetime.now(timezone.utc).isoformat(), last_post_id, tag_id),
        )
        await db.commit()
    finally:
        await db.close()


async def get_stats() -> dict:
    db = await get_db()
    try:
        # One grouped scan over posts (uses idx_posts_downloaded) instead of
        # four separate full COUNT(*) scans — much faster on ~1M rows.
        cursor = await db.execute("SELECT downloaded, COUNT(*) AS c FROM posts GROUP BY downloaded")
        by = {row["downloaded"]: row["c"] for row in await cursor.fetchall()}
        total = sum(by.values())
        cursor = await db.execute("SELECT COUNT(*) as c FROM tags")
        tag_count = (await cursor.fetchone())["c"]
        cursor = await db.execute("SELECT site, COUNT(*) AS c FROM posts GROUP BY site")
        by_site = {r["site"]: r["c"] for r in await cursor.fetchall()}
        cursor = await db.execute("SELECT COUNT(*) AS c FROM media_files")
        media_files = (await cursor.fetchone())["c"]
        # Cross-site duplicates actually collapsed: md5s seen on 2+ sites.
        cursor = await db.execute(
            "SELECT COUNT(*) AS c FROM (SELECT md5 FROM posts WHERE md5 IS NOT NULL "
            "GROUP BY md5 HAVING COUNT(DISTINCT site) > 1)")
        cross_dupes = (await cursor.fetchone())["c"]
        return {
            "total_posts": total,
            "downloaded": by.get(1, 0),
            "pending": by.get(0, 0),
            "failed": by.get(-1, 0),
            "total_tags": tag_count,
            "by_site": by_site,
            "media_files": media_files,
            "cross_site_dupes": cross_dupes,
        }
    finally:
        await db.close()


async def get_untyped_tags(limit: int = 50) -> list[dict]:
    """Tags whose type hasn't been fetched yet, most-common first (so the tags
    most likely to appear on viewed images get typed earliest)."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT id, name FROM tags WHERE type_fetched = 0 "
            "ORDER BY post_count DESC LIMIT ?",
            (limit,),
        )
        return [{"id": r["id"], "name": r["name"]} for r in await cursor.fetchall()]
    finally:
        await db.close()


@retry_on_locked
async def set_tag_type(tag_id: int, tag_type: int):
    """Record a tag's fetched type (marks it typed so it isn't re-fetched)."""
    db = await get_db()
    try:
        await db.execute(
            "UPDATE tags SET tag_type = ?, type_fetched = 1 WHERE id = ?",
            (tag_type, tag_id),
        )
        await db.commit()
    finally:
        await db.close()


@retry_on_locked
async def set_tag_type_by_name(name: str, tag_type: int):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE tags SET tag_type = ?, type_fetched = 1 WHERE name = ?",
            (tag_type, name),
        )
        await db.commit()
    finally:
        await db.close()


async def typing_progress() -> dict:
    """Counts for the tag-typing backfill (typed vs remaining)."""
    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT type_fetched, COUNT(*) c FROM tags GROUP BY type_fetched"
        )
        by = {r["type_fetched"]: r["c"] for r in await cur.fetchall()}
        return {"typed": by.get(1, 0), "untyped": by.get(0, 0)}
    finally:
        await db.close()


async def get_tag_counts(names: list[str]) -> dict:
    """Global post_count for the given tag names (missing names omitted)."""
    if not names:
        return {}
    db = await get_db()
    try:
        out: dict = {}
        CH = 900  # stay under SQLite's variable limit
        for i in range(0, len(names), CH):
            chunk = names[i:i + CH]
            ph = ",".join("?" * len(chunk))
            cur = await db.execute(
                f"SELECT name, post_count FROM tags WHERE name IN ({ph})", chunk
            )
            for r in await cur.fetchall():
                out[r["name"]] = r["post_count"]
        return out
    finally:
        await db.close()


async def browse_posts(
    tags: str | None = None,
    page: int = 1,
    per_page: int = 40,
    sort: str = "newest",
    rating: str | None = None,
    downloaded_only: bool = False,
    sites: list[str] | None = None,
) -> tuple[list[dict], int]:
    """Return paginated posts with optional tag filtering.

    MULTI-SITE: `sites` narrows to those sites' posts; cross-site duplicates
    (same md5) collapse to ONE representative row per dedup key — an image is
    hidden only when every site it appears on is filtered out. Posts without
    an md5 dedup as themselves (site:site_post_id)."""
    db = await get_db()
    try:
        conditions = []
        params: list = []

        if downloaded_only:
            conditions.append("p.downloaded = 1")

        if rating:
            conditions.append("p.rating = ?")
            params.append(rating)

        if sites:
            sph = ",".join("?" * len(sites))
            conditions.append(f"p.site IN ({sph})")
            params.extend(sites)

        if tags:
            tag_list = [t.strip() for t in tags.split() if t.strip()]
            # Resolve names to ids once (indexed), then match with ONE
            # aggregated subquery instead of a correlated subquery per tag —
            # far cheaper on the large post_tags table. AND semantics: a post
            # must carry every requested tag.
            ph = ",".join("?" * len(tag_list))
            cur = await db.execute(
                f"SELECT id FROM tags WHERE name IN ({ph})", tag_list
            )
            tag_ids = [r["id"] for r in await cur.fetchall()]
            if len(tag_ids) != len(tag_list):
                return [], 0  # an unknown tag can't match anything locally
            tph = ",".join("?" * len(tag_ids))
            conditions.append(
                f"p.id IN (SELECT pt.post_id FROM post_tags pt "
                f"WHERE pt.tag_id IN ({tph}) GROUP BY pt.post_id "
                f"HAVING COUNT(DISTINCT pt.tag_id) = {len(tag_ids)})"
            )
            params.extend(tag_ids)

        where = "WHERE " + " AND ".join(conditions) if conditions else ""

        order = {
            "newest": "p.id DESC",
            "score": "p.score DESC",
            "recent_download": "p.scraped_at DESC",
        }.get(sort, "p.id DESC")

        # Cross-site dedup: one row per md5 (rows without an md5 are their own
        # key). ROW_NUMBER keeps the first row in the requested ORDER, so the
        # representative is whatever the sort would have shown first.
        DEDUP_KEY = "COALESCE(p.md5, p.site || ':' || CAST(p.site_post_id AS TEXT))"
        dedup_ids_sql = (
            f"SELECT id FROM (SELECT p.id AS id, ROW_NUMBER() OVER "
            f"(PARTITION BY {DEDUP_KEY} ORDER BY {order}) AS rn "
            f"FROM posts p {where}) WHERE rn = 1"
        )

        offset = (page - 1) * per_page
        _now = time.monotonic()

        if tags and tags.strip():
            # Tag-filtered: cache the full ordered id list once, then page turns
            # are pure slicing + a 40-row fetch (the tag-match subquery runs only
            # on a cache miss, not on every page).
            ck = (tags, rating or "", bool(downloaded_only), sort, tuple(sites or ()))
            c = _BROWSE_IDS.get(ck)
            if c and _now - c[1] < _BROWSE_COUNT_TTL:
                ids = c[0]
            else:
                cur = await db.execute(
                    f"SELECT p.id FROM posts p {where} "
                    f"AND p.id IN ({dedup_ids_sql}) ORDER BY {order}"
                    if conditions else
                    f"SELECT p.id FROM posts p WHERE p.id IN ({dedup_ids_sql}) ORDER BY {order}",
                    params + params
                )
                ids = [r[0] for r in await cur.fetchall()]
                _BROWSE_IDS[ck] = (ids, _now)
            total = len(ids)
            page_ids = ids[offset:offset + per_page]
            if not page_ids:
                return [], total
            iph = ",".join("?" * len(page_ids))
            cur = await db.execute(
                f"SELECT p.* FROM posts p WHERE p.id IN ({iph})", page_ids
            )
            by_id = {r["id"]: dict(r) for r in await cur.fetchall()}
            return [by_id[i] for i in page_ids if i in by_id], total

        # Unfiltered (or rating/downloaded/sites only): the dedup window scan
        # over ~1M rows must not run on EVERY page turn — cache the ordered,
        # deduped id list exactly like the tag path and slice it.
        ck = ("__nofilter__", rating or "", bool(downloaded_only), sort, tuple(sites or ()))
        c = _BROWSE_IDS.get(ck)
        if c and _now - c[1] < _BROWSE_COUNT_TTL:
            ids = c[0]
        else:
            cur = await db.execute(
                f"SELECT id FROM (SELECT p.id AS id, ROW_NUMBER() OVER "
                f"(PARTITION BY {DEDUP_KEY} ORDER BY {order}) AS rn, "
                f"p.id AS oid FROM posts p {where}) WHERE rn = 1 ORDER BY oid DESC"
                if sort == "newest" else
                f"SELECT p.id FROM posts p WHERE p.id IN ({dedup_ids_sql}) ORDER BY {order}",
                params if sort == "newest" else params + params,
            )
            ids = [r[0] for r in await cur.fetchall()]
            _BROWSE_IDS[ck] = (ids, _now)
        total = len(ids)
        page_ids = ids[offset:offset + per_page]
        if not page_ids:
            return [], total
        iph = ",".join("?" * len(page_ids))
        cur = await db.execute(
            f"SELECT p.* FROM posts p WHERE p.id IN ({iph})", page_ids)
        by_id = {r["id"]: dict(r) for r in await cur.fetchall()}
        return [by_id[i] for i in page_ids if i in by_id], total
    finally:
        await db.close()


async def get_post(post_id: int) -> dict | None:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM posts WHERE id = ?", (post_id,))
        row = await cursor.fetchone()
        if not row:
            return None
        post = dict(row)
        # Get tag names
        cursor = await db.execute(
            """SELECT t.name, t.tag_type, t.type_fetched FROM tags t
               JOIN post_tags pt ON pt.tag_id = t.id
               WHERE pt.post_id = ?
               ORDER BY t.name""",
            (post_id,),
        )
        tag_rows = await cursor.fetchall()
        post["tag_list"] = [
            {"name": r["name"], "type": r["tag_type"], "typed": bool(r["type_fetched"])}
            for r in tag_rows
        ]
        # Tags on this viewed post that still need typing — the route bumps
        # these to the front of the typing queue so they fill in quickly.
        post["untyped_tags"] = [r["name"] for r in tag_rows if not r["type_fetched"]]
        return post
    finally:
        await db.close()


async def search_tags(query: str, limit: int = 20) -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT name, post_count, tag_type FROM tags WHERE name LIKE ? ORDER BY post_count DESC LIMIT ?",
            (f"%{query}%", limit),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        await db.close()


@retry_on_locked
async def forget_media_file(md5: str):
    """Drop an md5's media_files row whose file no longer exists on disk."""
    if not md5:
        return
    db = await get_db()
    try:
        await db.execute("DELETE FROM media_files WHERE md5 = ?", (md5,))
        await db.commit()
    finally:
        await db.close()
