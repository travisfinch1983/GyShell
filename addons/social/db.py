"""SQLite state for the social scraper addon (Instagram + X/Twitter + RedGIFs + Bluesky).

Plain sqlite3 behind one lock; the async app calls these through asyncio.to_thread.
"""

import os
import sqlite3
import threading
import time

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DATA_DIR, "social.db")
SITES = ("instagram", "twitter", "redgifs", "bluesky")

DEFAULTS = {
    "storage_path": "/nas/zpoolalpha/media/social",
    "poll_interval_h": "12",
    "include_videos": "0",
    "first_sync_limit": "0",          # 0 = whole history on an account's first sync
    "instagram.include": "posts",
    "instagram.sleep": "6-12",        # seconds between API requests (gallery-dl sleep-request)
    "instagram.paused": "0",
    "twitter.sleep": "2-5",
    "twitter.retweets": "0",
    "twitter.paused": "0",
    "redgifs.sleep": "1-2",
    "redgifs.paused": "0",
    "bluesky.sleep": "1-2",
    "bluesky.reposts": "0",
    "bluesky.fast": "1",             # JPEGs from cdn.bsky.app (see gdl_bluesky.py)
    "bluesky.paused": "0",
}

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                site TEXT NOT NULL,
                handle TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                complete INTEGER NOT NULL DEFAULT 0,   -- a full-history pass has finished
                added_at REAL NOT NULL,
                last_synced_at REAL,
                last_status TEXT,
                last_error TEXT,
                last_new INTEGER,
                UNIQUE(site, handle COLLATE NOCASE)
            );
            CREATE TABLE IF NOT EXISTS media (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                site TEXT NOT NULL,
                account_id INTEGER NOT NULL,
                rel TEXT NOT NULL,                     -- path under storage_path
                post_id TEXT,
                post_url TEXT,
                posted_at REAL,
                caption TEXT,
                width INTEGER,
                height INTEGER,
                size INTEGER,
                is_video INTEGER NOT NULL DEFAULT 0,
                added_at REAL NOT NULL,
                UNIQUE(rel)
            );
            CREATE INDEX IF NOT EXISTS media_acct ON media(account_id, posted_at);
            CREATE INDEX IF NOT EXISTS media_site ON media(site, posted_at);
            """
        )
    return _conn


def get_settings() -> dict:
    with _lock:
        rows = _db().execute("SELECT key, value FROM settings").fetchall()
    out = dict(DEFAULTS)
    out.update({r["key"]: r["value"] for r in rows})
    return out


def get_setting(key: str) -> str:
    return get_settings().get(key, "")


def set_settings(updates: dict) -> None:
    with _lock:
        c = _db()
        for k, v in updates.items():
            c.execute("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (k, "" if v is None else str(v)))
        c.commit()


def del_setting(key: str) -> None:
    with _lock:
        _db().execute("DELETE FROM settings WHERE key=?", (key,))
        _db().commit()


# ---- accounts ----

def list_accounts(site: str) -> list[dict]:
    with _lock:
        rows = _db().execute(
            """SELECT a.*, (SELECT COUNT(*) FROM media m WHERE m.account_id=a.id) AS n_media
               FROM accounts a WHERE a.site=? ORDER BY a.handle COLLATE NOCASE""", (site,)).fetchall()
    return [dict(r) for r in rows]


def get_account(acct_id: int) -> dict | None:
    with _lock:
        r = _db().execute("SELECT * FROM accounts WHERE id=?", (acct_id,)).fetchone()
    return dict(r) if r else None


def add_account(site: str, handle: str) -> int:
    with _lock:
        c = _db()
        r = c.execute("SELECT id FROM accounts WHERE site=? AND handle=? COLLATE NOCASE", (site, handle)).fetchone()
        if r:
            return int(r["id"])
        cur = c.execute("INSERT INTO accounts(site, handle, added_at) VALUES(?, ?, ?)", (site, handle, time.time()))
        c.commit()
        return int(cur.lastrowid)


def remove_account(acct_id: int) -> None:
    with _lock:
        c = _db()
        c.execute("DELETE FROM media WHERE account_id=?", (acct_id,))
        c.execute("DELETE FROM accounts WHERE id=?", (acct_id,))
        c.commit()


def update_account(acct_id: int, **fields) -> None:
    if not fields:
        return
    keys = ", ".join(f"{k}=?" for k in fields)
    with _lock:
        _db().execute(f"UPDATE accounts SET {keys} WHERE id=?", (*fields.values(), acct_id))
        _db().commit()


# ---- media ----

def known_rels(account_id: int) -> set[str]:
    with _lock:
        rows = _db().execute("SELECT rel FROM media WHERE account_id=?", (account_id,)).fetchall()
    return {r["rel"] for r in rows}


def insert_media(row: dict) -> bool:
    cols = ("site", "account_id", "rel", "post_id", "post_url", "posted_at", "caption", "width", "height",
            "size", "is_video", "added_at")
    with _lock:
        c = _db()
        cur = c.execute(f"INSERT OR IGNORE INTO media({', '.join(cols)}) VALUES({', '.join('?' for _ in cols)})",
                        tuple(row.get(k) for k in cols))
        c.commit()
        return cur.rowcount > 0


def delete_media_rows(ids: list[int]) -> None:
    with _lock:
        c = _db()
        c.executemany("DELETE FROM media WHERE id=?", [(i,) for i in ids])
        c.commit()


def delete_missing(account_id: int, rels: list[str]) -> None:
    with _lock:
        c = _db()
        c.executemany("DELETE FROM media WHERE account_id=? AND rel=?", [(account_id, r) for r in rels])
        c.commit()


def get_media(mid: int) -> dict | None:
    with _lock:
        r = _db().execute(
            "SELECT m.*, a.handle FROM media m JOIN accounts a ON a.id=m.account_id WHERE m.id=?", (mid,)).fetchone()
    return dict(r) if r else None


SORTS = {
    "newest": "COALESCE(m.posted_at, m.added_at) DESC, m.id DESC",
    "oldest": "COALESCE(m.posted_at, m.added_at) ASC, m.id ASC",
    "recent": "m.added_at DESC, m.id DESC",
    "largest": "(COALESCE(m.width,0) * COALESCE(m.height,0)) DESC, m.id DESC",
}


def browse(site: str, account_id: int | None, page: int, per_page: int, sort: str, videos: bool,
           q: str = "") -> tuple[list[dict], int]:
    where = ["m.site=?"]
    args: list = [site]
    if account_id:
        where.append("m.account_id=?")
        args.append(account_id)
    if not videos:
        where.append("m.is_video=0")
    if q:
        where.append("m.caption LIKE ?")
        args.append(f"%{q}%")
    w = " AND ".join(where)
    order = SORTS.get(sort, SORTS["newest"])
    with _lock:
        c = _db()
        total = c.execute(f"SELECT COUNT(*) FROM media m WHERE {w}", args).fetchone()[0]
        rows = c.execute(
            f"""SELECT m.id, m.rel, m.post_id, m.post_url, m.posted_at, m.width, m.height, m.is_video, a.handle
                FROM media m JOIN accounts a ON a.id=m.account_id WHERE {w} ORDER BY {order} LIMIT ? OFFSET ?""",
            (*args, per_page, (page - 1) * per_page)).fetchall()
    return [dict(r) for r in rows], int(total)


def site_stats(site: str) -> dict:
    with _lock:
        c = _db()
        n_acc = c.execute("SELECT COUNT(*) FROM accounts WHERE site=?", (site,)).fetchone()[0]
        n_on = c.execute("SELECT COUNT(*) FROM accounts WHERE site=? AND enabled=1", (site,)).fetchone()[0]
        n_img = c.execute("SELECT COUNT(*) FROM media WHERE site=? AND is_video=0", (site,)).fetchone()[0]
        n_vid = c.execute("SELECT COUNT(*) FROM media WHERE site=? AND is_video=1", (site,)).fetchone()[0]
        size = c.execute("SELECT COALESCE(SUM(size),0) FROM media WHERE site=?", (site,)).fetchone()[0]
    return {"accounts": n_acc, "active_accounts": n_on, "images": n_img, "videos": n_vid, "bytes": int(size)}
