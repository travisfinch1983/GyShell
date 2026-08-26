"""SQLite schema, migrations, and query helpers for Rule34 scraper addon."""

import aiosqlite
import os
import time
from datetime import datetime, timezone

# Cache of per-watched-tag live download counts, refreshed by a background loop
# so request handlers never pay the heavy junction-table aggregation.
_WT_AGG: dict = {"data": {}, "ts": 0.0}

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


async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA busy_timeout=30000")
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


async def remove_api_key(key_id: int):
    db = await get_db()
    try:
        await db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        await db.commit()
    finally:
        await db.close()


async def set_api_key_enabled(key_id: int, enabled: bool):
    db = await get_db()
    try:
        await db.execute(
            "UPDATE api_keys SET enabled = ? WHERE id = ?", (1 if enabled else 0, key_id)
        )
        await db.commit()
    finally:
        await db.close()


async def upsert_post(post: dict) -> bool:
    """Insert or ignore a post. Returns True if newly inserted."""
    db = await get_db()
    try:
        cursor = await db.execute(
            """INSERT OR IGNORE INTO posts
               (id, file_url, preview_url, sample_url, tags, score, rating, source,
                width, height, file_ext, file_size, created_at, scraped_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                post["id"],
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
        inserted = cursor.rowcount > 0
        await db.commit()
        return inserted
    finally:
        await db.close()


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


async def link_posts_to_watched_tag(watched_tag_id: int, post_ids: list[int]):
    """Record which posts belong to a watched tag (for live progress tracking)."""
    if not post_ids:
        return
    db = await get_db()
    try:
        await db.executemany(
            "INSERT OR IGNORE INTO watched_tag_posts (watched_tag_id, post_id) VALUES (?, ?)",
            [(watched_tag_id, pid) for pid in post_ids],
        )
        await db.commit()
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


async def remove_watched_tag(tag_id: int):
    db = await get_db()
    try:
        await db.execute("DELETE FROM watched_tag_posts WHERE watched_tag_id = ?", (tag_id,))
        await db.execute("DELETE FROM watched_tags WHERE id = ?", (tag_id,))
        await db.commit()
    finally:
        await db.close()


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
        return {
            "total_posts": total,
            "downloaded": by.get(1, 0),
            "pending": by.get(0, 0),
            "failed": by.get(-1, 0),
            "total_tags": tag_count,
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
) -> tuple[list[dict], int]:
    """Return paginated posts with optional tag filtering."""
    db = await get_db()
    try:
        conditions = []
        params: list = []

        if downloaded_only:
            conditions.append("p.downloaded = 1")

        if rating:
            conditions.append("p.rating = ?")
            params.append(rating)

        if tags:
            tag_list = [t.strip() for t in tags.split() if t.strip()]
            for tag in tag_list:
                conditions.append(
                    "p.id IN (SELECT pt.post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)"
                )
                params.append(tag)

        where = "WHERE " + " AND ".join(conditions) if conditions else ""

        order = {
            "newest": "p.id DESC",
            "score": "p.score DESC",
            "recent_download": "p.scraped_at DESC",
        }.get(sort, "p.id DESC")

        count_sql = f"SELECT COUNT(*) as c FROM posts p {where}"
        cursor = await db.execute(count_sql, params)
        total = (await cursor.fetchone())["c"]

        offset = (page - 1) * per_page
        query_sql = f"SELECT p.* FROM posts p {where} ORDER BY {order} LIMIT ? OFFSET ?"
        cursor = await db.execute(query_sql, params + [per_page, offset])
        rows = await cursor.fetchall()
        return [dict(row) for row in rows], total
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
