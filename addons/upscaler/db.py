"""SQLite schema + ops. Single-file DB; concurrent-safe with WAL mode."""
import sqlite3
import time
from contextlib import contextmanager
from typing import Iterator
from config import DB_PATH, DEFAULT_SETTINGS

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,          -- 'tag' or 'album'
    external_id TEXT NOT NULL,   -- Immich tag/album UUID
    name TEXT NOT NULL,          -- cached display name
    role TEXT NOT NULL,          -- 'watch' or 'exclude'
    added_at INTEGER NOT NULL,
    UNIQUE(kind, external_id, role)
);

CREATE TABLE IF NOT EXISTS processed (
    asset_id TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL,
    new_asset_id TEXT,           -- the upscaled asset's ID in Immich
    model TEXT,
    status TEXT NOT NULL,        -- 'ok' or 'failed'
    error TEXT,
    src_mp REAL,
    elapsed_sec REAL,
    filename TEXT,               -- cached for history display
    src_w INTEGER,               -- source dimensions
    src_h INTEGER,
    dst_w INTEGER,               -- upscaled dimensions
    dst_h INTEGER
);

CREATE TABLE IF NOT EXISTS queue (
    asset_id TEXT PRIMARY KEY,
    enqueued_at INTEGER NOT NULL,
    status TEXT NOT NULL,        -- 'pending' / 'processing' / 'done' / 'failed'
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    last_error TEXT,
    source_ref TEXT,             -- e.g. 'album:UUID' or 'tag:UUID' or 'manual'
    agent_name TEXT,             -- while processing: container name
    cuda_index INTEGER,          -- while processing: GPU index
    filename TEXT,               -- cached display name
    started_at INTEGER           -- when this attempt started
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gpu_selections (
    agent_name TEXT NOT NULL,    -- proxlab host_node (e.g. "px-gpu", "px-epyc")
    cuda_index INTEGER NOT NULL,
    agent_ip TEXT,               -- cached SSH target
    container_name TEXT,         -- cached display name
    friendly_name TEXT,          -- cached e.g. "GeForce RTX 4090 #0"
    vram_mb INTEGER,             -- cached
    enabled INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (agent_name, cuda_index)
);
"""


@contextmanager
def conn() -> Iterator[sqlite3.Connection]:
    c = sqlite3.connect(DB_PATH, isolation_level=None)
    c.row_factory = sqlite3.Row
    try:
        yield c
    finally:
        c.close()


def _ensure_column(c, table: str, column: str, decl: str):
    """Add a column to a table if it doesn't already exist."""
    cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def init():
    with conn() as c:
        c.executescript(SCHEMA)
        # Migrations for existing DBs that predate newer columns
        _ensure_column(c, "queue", "agent_name", "TEXT")
        _ensure_column(c, "queue", "cuda_index", "INTEGER")
        _ensure_column(c, "queue", "filename", "TEXT")
        _ensure_column(c, "queue", "started_at", "INTEGER")
        _ensure_column(c, "processed", "filename", "TEXT")
        _ensure_column(c, "processed", "src_w", "INTEGER")
        _ensure_column(c, "processed", "src_h", "INTEGER")
        _ensure_column(c, "processed", "dst_w", "INTEGER")
        _ensure_column(c, "processed", "dst_h", "INTEGER")
        # Seed defaults only if missing (don't clobber user changes)
        for k, v in DEFAULT_SETTINGS.items():
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO NOTHING",
                (k, v),
            )


# ---- Settings ----

def get_setting(key: str, default: str | None = None) -> str | None:
    with conn() as c:
        row = c.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with conn() as c:
        c.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def all_settings() -> dict[str, str]:
    with conn() as c:
        return {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM settings")}


# ---- Sources ----

def add_source(kind: str, external_id: str, name: str, role: str) -> bool:
    assert kind in ("tag", "album")
    assert role in ("watch", "exclude")
    with conn() as c:
        try:
            c.execute(
                "INSERT INTO sources (kind, external_id, name, role, added_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (kind, external_id, name, role, int(time.time())),
            )
            return True
        except sqlite3.IntegrityError:
            return False


def remove_source(source_id: int) -> None:
    with conn() as c:
        c.execute("DELETE FROM sources WHERE id = ?", (source_id,))


def list_sources(role: str | None = None) -> list[dict]:
    with conn() as c:
        if role:
            rows = c.execute(
                "SELECT * FROM sources WHERE role = ? ORDER BY kind, name", (role,)
            ).fetchall()
        else:
            rows = c.execute("SELECT * FROM sources ORDER BY role, kind, name").fetchall()
        return [dict(r) for r in rows]


# ---- Queue ----

def enqueue(asset_id: str, source_ref: str) -> bool:
    """Returns True if newly enqueued, False if already known."""
    with conn() as c:
        # Skip if already processed successfully
        r = c.execute(
            "SELECT status FROM processed WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        if r and r["status"] == "ok":
            return False
        try:
            c.execute(
                "INSERT INTO queue (asset_id, enqueued_at, status, source_ref) "
                "VALUES (?, ?, 'pending', ?)",
                (asset_id, int(time.time()), source_ref),
            )
            return True
        except sqlite3.IntegrityError:
            return False


def claim_pending(limit: int = 1) -> list[dict]:
    """Atomically grab N pending items and mark them processing."""
    now = int(time.time())
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM queue WHERE status = 'pending' "
            "ORDER BY enqueued_at LIMIT ?",
            (limit,),
        ).fetchall()
        out = []
        for r in rows:
            c.execute(
                "UPDATE queue SET status = 'processing', "
                "attempts = attempts + 1, last_attempt_at = ? "
                "WHERE asset_id = ? AND status = 'pending'",
                (now, r["asset_id"]),
            )
            out.append(dict(r))
        return out


def mark_dispatched(asset_id: str, agent_name: str, cuda_index: int, filename: str):
    """Record which GPU + which file this processing attempt is using."""
    now = int(time.time())
    with conn() as c:
        c.execute(
            "UPDATE queue SET agent_name=?, cuda_index=?, filename=?, started_at=? "
            "WHERE asset_id=?",
            (agent_name, cuda_index, filename, now, asset_id),
        )


def mark_done(asset_id: str, new_asset_id: str, model: str, src_mp: float,
              elapsed: float, filename: str | None = None,
              src_w: int | None = None, src_h: int | None = None,
              dst_w: int | None = None, dst_h: int | None = None):
    now = int(time.time())
    with conn() as c:
        c.execute(
            "INSERT INTO processed "
            "(asset_id, processed_at, new_asset_id, model, status, src_mp, elapsed_sec, "
            " filename, src_w, src_h, dst_w, dst_h) "
            "VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(asset_id) DO UPDATE SET "
            "processed_at=excluded.processed_at, new_asset_id=excluded.new_asset_id, "
            "model=excluded.model, status='ok', error=NULL, "
            "src_mp=excluded.src_mp, elapsed_sec=excluded.elapsed_sec, "
            "filename=COALESCE(excluded.filename, processed.filename), "
            "src_w=COALESCE(excluded.src_w, processed.src_w), "
            "src_h=COALESCE(excluded.src_h, processed.src_h), "
            "dst_w=COALESCE(excluded.dst_w, processed.dst_w), "
            "dst_h=COALESCE(excluded.dst_h, processed.dst_h)",
            (asset_id, now, new_asset_id, model, src_mp, elapsed,
             filename, src_w, src_h, dst_w, dst_h),
        )
        c.execute("DELETE FROM queue WHERE asset_id = ?", (asset_id,))


def list_processing() -> list[dict]:
    """Rows currently being processed -- for the live status panel."""
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM queue WHERE status='processing' ORDER BY started_at"
        ).fetchall()
        return [dict(r) for r in rows]


def list_processed(limit: int = 50, offset: int = 0,
                   status: str = "ok") -> list[dict]:
    """Paginated history rows, ordered newest-first.
    `status` defaults to 'ok' for back-compat; pass 'failed' for the failure view."""
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM processed WHERE status=? "
            "ORDER BY processed_at DESC LIMIT ? OFFSET ?",
            (status, limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]


def list_failed(limit: int = 50, offset: int = 0) -> list[dict]:
    """Paginated failures, newest-first. Convenience wrapper around list_processed."""
    return list_processed(limit=limit, offset=offset, status="failed")


def reset_stale_processing(older_than_sec: int = 0) -> int:
    """Reset rows that are stuck in 'processing' back to 'pending'.

    With older_than_sec=0, resets ALL processing rows (call on startup; the
    in-memory in_flight tracking is gone and the remote procs are dead).
    With a positive value, only resets rows whose started_at is older than
    that many seconds in the past (call periodically to catch hangs).
    """
    now = int(time.time())
    cutoff = now - older_than_sec
    with conn() as c:
        if older_than_sec <= 0:
            r = c.execute(
                "UPDATE queue SET status='pending', agent_name=NULL, "
                "cuda_index=NULL, started_at=NULL "
                "WHERE status='processing'"
            )
        else:
            r = c.execute(
                "UPDATE queue SET status='pending', agent_name=NULL, "
                "cuda_index=NULL, started_at=NULL "
                "WHERE status='processing' AND "
                "(started_at IS NULL OR started_at < ?)",
                (cutoff,),
            )
        return r.rowcount


def count_processed(status: str = "ok") -> int:
    with conn() as c:
        r = c.execute(
            "SELECT COUNT(*) AS n FROM processed WHERE status=?", (status,)
        ).fetchone()
        return r["n"] if r else 0


def count_failed() -> int:
    return count_processed(status="failed")


def get_processed(asset_id: str) -> dict | None:
    with conn() as c:
        r = c.execute(
            "SELECT * FROM processed WHERE asset_id=?", (asset_id,)
        ).fetchone()
        return dict(r) if r else None


def mark_failed(asset_id: str, error: str):
    now = int(time.time())
    with conn() as c:
        c.execute(
            "INSERT INTO processed (asset_id, processed_at, status, error) "
            "VALUES (?, ?, 'failed', ?) "
            "ON CONFLICT(asset_id) DO UPDATE SET "
            "processed_at=excluded.processed_at, status='failed', error=excluded.error",
            (asset_id, now, error),
        )
        c.execute(
            "UPDATE queue SET status='failed', last_error=? WHERE asset_id=?",
            (error, asset_id),
        )


def retry_failed(asset_id: str) -> bool:
    with conn() as c:
        # Reset queue entry to pending, drop processed.failed row
        r = c.execute(
            "UPDATE queue SET status='pending', last_error=NULL WHERE asset_id=? AND status='failed'",
            (asset_id,),
        )
        c.execute("DELETE FROM processed WHERE asset_id=? AND status='failed'", (asset_id,))
        return r.rowcount > 0


def reprocess_one(asset_id: str, source_ref: str = "reprocess") -> bool:
    """Clear the processed entry (ok or failed) + (re-)enqueue the asset.
    Used by the history-page retry/reprocess actions. The worker will pick it
    up and use the CURRENT active model setting — so switch the model first
    if you want a re-run with a different upscaler."""
    now = int(time.time())
    with conn() as c:
        # Drop any prior processed result so the worker won't skip
        c.execute("DELETE FROM processed WHERE asset_id=?", (asset_id,))
        # Enqueue or reset existing queue row
        c.execute(
            "INSERT INTO queue (asset_id, enqueued_at, status, source_ref) "
            "VALUES (?, ?, 'pending', ?) "
            "ON CONFLICT(asset_id) DO UPDATE SET "
            "status='pending', last_error=NULL, attempts=0, "
            "agent_name=NULL, cuda_index=NULL, started_at=NULL, "
            "source_ref=?",
            (asset_id, now, source_ref, source_ref),
        )
    return True


def reprocess_batch(asset_ids: list[str], source_ref: str = "reprocess") -> int:
    """Bulk version of reprocess_one. Returns count enqueued."""
    n = 0
    for aid in asset_ids:
        if reprocess_one(aid, source_ref=source_ref):
            n += 1
    return n


def list_failed_asset_ids() -> list[str]:
    """Return every failed asset_id — for the "retry all failed" button."""
    with conn() as c:
        rows = c.execute(
            "SELECT asset_id FROM processed WHERE status='failed'"
        ).fetchall()
        return [r["asset_id"] for r in rows]


def list_processed_filtered(asset_id_set: set[str], status: str,
                            limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
    """List+count processed rows where EITHER the original asset_id OR the
    upscaled new_asset_id is in `asset_id_set`. Matching both columns is
    essential because after stacking, the album/tag membership in Immich
    follows the upscaled (the new primary) while we track the original.
    Returns (page_rows, total_matching). Filter applied in Python to dodge
    SQLite IN-clause param limits; fine for our scale (low 10k)."""
    if not asset_id_set:
        return [], 0
    with conn() as c:
        all_rows = c.execute(
            "SELECT * FROM processed WHERE status=? ORDER BY processed_at DESC",
            (status,),
        ).fetchall()
    matched = [dict(r) for r in all_rows
               if r["asset_id"] in asset_id_set
               or (r["new_asset_id"] and r["new_asset_id"] in asset_id_set)]
    total = len(matched)
    return matched[offset:offset + limit], total


def list_failed_asset_ids_in(asset_id_set: set[str]) -> list[str]:
    """For "Retry all failed in this filter" — intersection of failures and a
    caller-supplied set. Matches against original asset_id only; failures
    rarely have a new_asset_id set, but include it as a safety belt."""
    if not asset_id_set:
        return []
    with conn() as c:
        rows = c.execute(
            "SELECT asset_id, new_asset_id FROM processed WHERE status='failed'"
        ).fetchall()
        return [r["asset_id"] for r in rows
                if r["asset_id"] in asset_id_set
                or (r["new_asset_id"] and r["new_asset_id"] in asset_id_set)]


def queue_summary() -> dict[str, int]:
    with conn() as c:
        rows = c.execute(
            "SELECT status, COUNT(*) as n FROM queue GROUP BY status"
        ).fetchall()
        return {r["status"]: r["n"] for r in rows}


def processed_summary() -> dict[str, int]:
    """How many ok / failed today."""
    cutoff = int(time.time()) - 86400
    with conn() as c:
        rows = c.execute(
            "SELECT status, COUNT(*) as n FROM processed "
            "WHERE processed_at >= ? GROUP BY status",
            (cutoff,),
        ).fetchall()
        return {r["status"]: r["n"] for r in rows}


def recent_activity(limit: int = 20) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM processed ORDER BY processed_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def is_processed(asset_id: str) -> bool:
    with conn() as c:
        r = c.execute(
            "SELECT status FROM processed WHERE asset_id=? AND status='ok'",
            (asset_id,),
        ).fetchone()
        return r is not None


# ---- GPU selections ----

def upsert_gpu_inventory(snapshot: list[dict]) -> None:
    """Replace cached GPU metadata from a proxlab /api/ai/agent-gpus response.

    `snapshot` is a flat list of dicts:
      { agent_name, cuda_index, agent_ip, container_name, friendly_name, vram_mb }

    Preserves the existing `enabled` flag for any (agent_name, cuda_index)
    that's still present. Rows whose key is no longer in the snapshot keep
    their state (so we can show 'stale' entries in the UI if the GPU went
    missing -- caller can prune separately if desired).
    """
    now = int(time.time())
    with conn() as c:
        for g in snapshot:
            c.execute(
                "INSERT INTO gpu_selections "
                "(agent_name, cuda_index, agent_ip, container_name, friendly_name, vram_mb, enabled, last_seen_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 0, ?) "
                "ON CONFLICT(agent_name, cuda_index) DO UPDATE SET "
                "agent_ip=excluded.agent_ip, container_name=excluded.container_name, "
                "friendly_name=excluded.friendly_name, vram_mb=excluded.vram_mb, "
                "last_seen_at=excluded.last_seen_at",
                (g["agent_name"], g["cuda_index"], g.get("agent_ip"),
                 g.get("container_name"), g.get("friendly_name"), g.get("vram_mb"), now),
            )


def set_gpu_enabled(agent_name: str, cuda_index: int, enabled: bool) -> None:
    with conn() as c:
        c.execute(
            "UPDATE gpu_selections SET enabled=? WHERE agent_name=? AND cuda_index=?",
            (1 if enabled else 0, agent_name, cuda_index),
        )


def list_all_gpus() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM gpu_selections ORDER BY container_name, cuda_index"
        ).fetchall()
        return [dict(r) for r in rows]


def list_enabled_gpus() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM gpu_selections WHERE enabled=1 ORDER BY container_name, cuda_index"
        ).fetchall()
        return [dict(r) for r in rows]


def set_gpu_selections_bulk(selections: dict) -> None:
    """Apply a dict of {(agent_name, cuda_index): bool} to enabled flags.

    All rows in gpu_selections are reset to disabled, then the supplied
    keys are flipped to enabled=1. Use after the UI form post.
    """
    with conn() as c:
        c.execute("UPDATE gpu_selections SET enabled=0")
        for (agent, idx), val in selections.items():
            if val:
                c.execute(
                    "UPDATE gpu_selections SET enabled=1 WHERE agent_name=? AND cuda_index=?",
                    (agent, idx),
                )
