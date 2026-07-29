"""One-way tag -> NAS training-image downloader/sync.

Watches selected Immich tags; for assets that carry BOTH a watched tag (or any of
its descendants) AND the auto-managed `upscaled` tag, downloads the upscaled file
into  <DEST_ROOT>/<full tag path>/  on the NAS, mirroring the tag nesting.

One-way + one-time per (tag, asset): a per-(tag,asset) ledger means a downloaded
image is never re-fetched — even if you delete the local file — UNLESS you reset
that tag's sync status, which clears the ledger (for that tag + its descendants)
and re-downloads only the images currently MISSING from the folders.

Never modifies Immich. Files are delivered to the NAS over SSH/rsync (the
companion has no mount of the dataset; it's local on the pbs host). A single
multiplexed SSH connection is reused for all ops, and each tag's new files are
shipped in one rsync — fast and connection-light.
"""
import asyncio
import json
import logging
import os
import re
import shlex
import shutil
import tempfile
import time
from pathlib import Path

import db
from immich import Immich

log = logging.getLogger("sync")

# ---- Cinder-friendly filenames: <leaf-folder-slug>-N.ext instead of <uuid>.png.
# A per-folder ".aig-names.json" map (asset_id -> friendly name) makes naming
# stable across ledger resets (the ledger keys on asset_id, but a reset clears
# it; the map lets us recognise an asset that's already on disk under its name).
_NAMEMAP = ".aig-names.json"


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9_-]+", "-", (s or "").strip().lower())
    return re.sub(r"-{2,}", "-", s).strip("-_") or "img"


def _folder_base(rel: str) -> str:
    leaf = rel.rstrip("/").split("/")[-1] if rel else "img"
    return _slug(leaf)


def _load_namemap(folder: str) -> dict:
    try:
        with open(os.path.join(folder, _NAMEMAP)) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_namemap(folder: str, m: dict):
    try:
        p = os.path.join(folder, _NAMEMAP)
        with open(p, "w") as f:
            json.dump(m, f)
        os.chmod(p, 0o664)
    except Exception as e:
        log.warning(f"sync: write namemap {folder} failed: {e}")


def _max_n(base: str, names) -> int:
    rx = re.compile(r"^" + re.escape(base) + r"-(\d+)\.")
    mx = 0
    for n in names:
        m = rx.match(n)
        if m:
            mx = max(mx, int(m.group(1)))
    return mx

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sync_sources (
    tag_id     TEXT PRIMARY KEY,
    tag_value  TEXT,
    added_at   REAL
);
CREATE TABLE IF NOT EXISTS synced (
    tag_id        TEXT NOT NULL,
    asset_id      TEXT NOT NULL,
    filename      TEXT,
    downloaded_at REAL,
    PRIMARY KEY (tag_id, asset_id)
);
"""

_CM_PATH = "/tmp/sync-cm-%r@%h:%p"   # ssh ControlMaster socket
_DL_CONCURRENCY = 6


def init():
    with db.conn() as c:
        c.executescript(_SCHEMA)


# ---- settings ----
def _enabled() -> bool: return db.get_setting("sync_enabled", "1") == "1"
def _interval() -> int: return int(db.get_setting("sync_poll_interval_sec", "300") or 300)
def _dest_host() -> str: return db.get_setting("sync_dest_host", "10.0.0.17")
def _dest_root() -> str:
    return db.get_setting("sync_dest_root",
                          "/mnt/flashpool/ai-assets/imagegen/training_images")
def _upscaled_tag_name() -> str: return db.get_setting("auto_managed_tag", "upscaled")
# Local-copy mode (companion has Immich storage + training_images bind-mounted):
def _local_dest() -> str: return db.get_setting("sync_local_dest", "/training_images")
def _immich_src_root() -> str: return db.get_setting("immich_src_root", "/immich-src")
def _immich_prefix() -> str: return db.get_setting("immich_upload_prefix", "/opt/immich/upload")


# ---- source / ledger CRUD ----
def add_source(tag_id: str, tag_value: str):
    with db.conn() as c:
        c.execute("INSERT OR REPLACE INTO sync_sources (tag_id, tag_value, added_at) "
                  "VALUES (?,?,?)", (tag_id, tag_value, time.time()))

def remove_source(tag_id: str):
    with db.conn() as c:
        c.execute("DELETE FROM sync_sources WHERE tag_id=?", (tag_id,))

def list_sources() -> list[dict]:
    with db.conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM sync_sources ORDER BY tag_value").fetchall()]

def is_synced(tag_id: str, asset_id: str) -> bool:
    with db.conn() as c:
        return c.execute("SELECT 1 FROM synced WHERE tag_id=? AND asset_id=?",
                         (tag_id, asset_id)).fetchone() is not None

def synced_ids(tag_id: str) -> set:
    with db.conn() as c:
        return {r[0] for r in c.execute(
            "SELECT asset_id FROM synced WHERE tag_id=?", (tag_id,)).fetchall()}

def mark_synced(tag_id: str, asset_id: str, filename: str):
    with db.conn() as c:
        c.execute("INSERT OR REPLACE INTO synced (tag_id, asset_id, filename, downloaded_at) "
                  "VALUES (?,?,?,?)", (tag_id, asset_id, filename, time.time()))

def count_synced(tag_id: str) -> int:
    with db.conn() as c:
        return c.execute("SELECT COUNT(*) FROM synced WHERE tag_id=?",
                         (tag_id,)).fetchone()[0]

def reset_source(effective_tag_ids: list[str]) -> int:
    if not effective_tag_ids:
        return 0
    with db.conn() as c:
        n = 0
        for tid in effective_tag_ids:
            n += c.execute("DELETE FROM synced WHERE tag_id=?", (tid,)).rowcount
        return n


class SyncWorker:
    def __init__(self, immich: Immich):
        self.immich = immich
        self.task: asyncio.Task | None = None
        self._stop = False
        self._lock = asyncio.Lock()         # single-flight: one pass at a time
        self._tag_index: dict[str, dict] = {}
        self.last_run = 0.0
        self.progress = {
            "running": False, "source": "", "tag": "",
            "tags_done": 0, "tags_total": 0, "delivered": 0,
            "skipped": 0, "errors": 0, "started": 0.0,
        }

    async def start(self):
        init()
        if self.task and not self.task.done():
            return
        self._stop = False
        self.task = asyncio.create_task(self._loop(), name="sync-worker")

    async def stop(self):
        self._stop = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    # ---- tag tree ----
    async def refresh_tag_index(self) -> dict[str, dict]:
        tags = await self.immich.list_tags()
        self._tag_index = {t["id"]: t for t in tags if t.get("id")}
        return self._tag_index

    def _children_of(self, tag_id: str) -> list[str]:
        return [tid for tid, t in self._tag_index.items() if t.get("parentId") == tag_id]

    def effective_tags(self, root_id: str) -> list[str]:
        out, stack, seen = [], [root_id], set()
        while stack:
            tid = stack.pop()
            if tid in seen or tid not in self._tag_index:
                continue
            seen.add(tid)
            out.append(tid)
            stack.extend(self._children_of(tid))
        return out

    def _resolve_tag_id(self, name: str) -> str | None:
        for t in self._tag_index.values():
            if (t.get("value") or t.get("name")) == name or t.get("name") == name:
                return t["id"]
        return None

    async def _ready_ids(self) -> list[str]:
        """Tag ids that mark an asset as training-ready: upscaled (got a hi-res
        copy) OR upscale-res (native res, no upscale needed). We pull either."""
        up = self._resolve_tag_id(_upscaled_tag_name())
        hr = self._resolve_tag_id(db.get_setting("highres_tag", "upscale-res"))
        return [x for x in (up, hr) if x]

    # ---- SSH/rsync (one multiplexed connection per pass) ----
    def _ssh_opts(self) -> list[str]:
        return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
                "-o", "ConnectTimeout=8",
                "-o", "ControlMaster=auto", "-o", f"ControlPath={_CM_PATH}",
                "-o", "ControlPersist=120"]

    async def _run(self, cmd: list[str], timeout: int = 600):
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill(); await proc.wait()
            return -1, "", "timeout"
        return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

    async def _ssh(self, remote_cmd: str, timeout: int = 60):
        return await self._run(["ssh", *self._ssh_opts(), _dest_host(), remote_cmd], timeout)

    async def _close_master(self):
        await self._run(["ssh", *self._ssh_opts(), "-O", "exit", _dest_host()], timeout=15)

    async def _remote_existing(self, folder: str) -> set[str]:
        _, out, _ = await self._ssh(f"ls -1 {shlex.quote(folder)} 2>/dev/null || true", timeout=30)
        return {ln.strip() for ln in out.splitlines() if ln.strip()}

    async def _rsync_dir(self, local_dir: str, folder: str) -> bool:
        """Ship a whole staging dir's contents into the remote folder in one shot."""
        rc, _, err = await self._ssh(f"mkdir -p {shlex.quote(folder)}", timeout=30)
        if rc != 0:
            log.warning(f"sync: mkdir {folder} failed: {err.strip()}")
            return False
        ssh_e = "ssh " + " ".join(shlex.quote(o) for o in self._ssh_opts())
        rc, _, err = await self._run(
            ["rsync", "-a", "--ignore-existing", "-e", ssh_e,
             local_dir.rstrip("/") + "/", f"{_dest_host()}:{shlex.quote(folder)}/"],
            timeout=3600)
        if rc != 0:
            log.warning(f"sync: rsync to {folder} failed: {err.strip()}")
            return False
        return True

    # ---- loop ----
    async def _loop(self):
        log.info("sync loop starting")
        while not self._stop:
            if not _enabled():
                await asyncio.sleep(10); continue
            try:
                await self._sync_once()
            except Exception as e:
                log.exception(f"sync pass failed: {e}")
            slept, iv = 0, _interval()
            while slept < iv and not self._stop:
                await asyncio.sleep(5); slept += 5
        log.info("sync loop stopped")

    def trigger(self):
        """Fire a pass now if one isn't already running (single-flight)."""
        if not self._lock.locked():
            asyncio.create_task(self._sync_once())

    async def _sync_once(self):
        if self._lock.locked():
            log.info("sync: pass already running; skipping overlap")
            return
        async with self._lock:
            await self._do_pass()

    async def _do_pass(self):
        sources = list_sources()
        if not sources:
            return
        await self.refresh_tag_index()
        ready_ids = await self._ready_ids()
        if not ready_ids:
            log.warning("sync: no upscaled/upscale-res tag found; skipping")
            return
        # Local-copy mode if Immich storage + dest are both mounted in-container
        # (everything's on the pbs host). Else fall back to SSH/rsync delivery.
        self._local = os.path.isdir(_immich_src_root()) and os.path.isdir(_local_dest())
        dest_root = (_local_dest() if self._local else _dest_root()).rstrip("/")
        log.info(f"sync: delivery mode = {'LOCAL copy' if self._local else 'SSH/rsync'}")
        # build full effective-tag worklist
        worklist = []
        for s in sources:
            for eff in self.effective_tags(s["tag_id"]):
                worklist.append((s["tag_value"], eff))
        self.progress.update(running=True, source="", tag="", tags_done=0,
                             tags_total=len(worklist), delivered=0, skipped=0,
                             errors=0, dl_done=0, dl_total=0, phase="scan",
                             started=time.time())
        log.info(f"sync: pass start — {len(sources)} source(s), {len(worklist)} effective tag(s)")
        try:
            # Phase 1 — scan: search every effective tag once. Immich tag search
            # is HIERARCHICAL (a parent returns all descendants' assets), so we
            # keep each tag's raw result to subtract children in phase 2.
            tag_assets = {}
            for i, (src_val, eff) in enumerate(worklist, 1):
                if self._stop:
                    break
                tg = self._tag_index.get(eff)
                self.progress["source"] = src_val
                self.progress["tag"] = (tg.get("value") if tg else eff) or eff
                self.progress["tags_done"] = i
                tag_assets[eff] = await self._assets_with(eff, ready_ids)
            # Phase 2 — copy: each folder gets only its EXACT-tagged images, i.e.
            # search(X) minus the union of its direct children's results. This
            # stops a parent folder from accumulating its children's images.
            self.progress["phase"] = "copy"
            self.progress["tags_done"] = 0
            for src_val, eff in worklist:
                if self._stop:
                    break
                tag = self._tag_index.get(eff)
                self.progress["source"] = src_val
                self.progress["tag"] = (tag.get("value") if tag else eff) or eff
                self.progress["tags_done"] += 1
                self.progress["dl_done"] = 0
                self.progress["dl_total"] = 0
                if not tag:
                    continue
                child_ids = set()
                for c in self._children_of(eff):
                    for a in tag_assets.get(c, []):
                        if a.get("id"):
                            child_ids.add(a["id"])
                exact = [a for a in tag_assets.get(eff, [])
                         if a.get("id") and a["id"] not in child_ids]
                try:
                    await self._sync_tag(eff, tag, exact, dest_root)
                except Exception as e:
                    log.warning(f"sync: tag {self.progress['tag']} failed: {e}")
                    self.progress["errors"] += 1
        finally:
            await self._close_master()
            self.progress["running"] = False
            self.progress["phase"] = "idle"
            self.last_run = time.time()
            log.info(f"sync: pass done — delivered {self.progress['delivered']}, "
                     f"skipped {self.progress['skipped']}, errors {self.progress['errors']}")

    async def _sync_tag(self, eff: str, tag: dict, assets: list, dest_root: str):
        """`assets` is the pre-computed EXACT-tagged set for this tag (parent
        folders have already had their children's images subtracted)."""
        rel = (tag.get("value") or tag.get("name") or eff).strip("/")
        folder = f"{dest_root}/{rel}"
        if not assets:
            return
        done = synced_ids(eff)
        pending = [a for a in assets if a.get("id") and a["id"] not in done]
        if not pending:
            return
        # Assign Cinder-friendly <base>-N names. existing on-disk names + the
        # persisted map give us the next number and reset-safety.
        base = _folder_base(rel)
        if self._local:
            existing = set(os.listdir(folder)) if os.path.isdir(folder) else set()
            nmap = _load_namemap(folder)
        else:
            existing = await self._remote_existing(folder)
            nmap = {}   # persistent map is LOCAL-mode only (the production mode)
        n = _max_n(base, set(existing) | set(nmap.values()))
        candidates = []
        for a in pending:
            aid = a["id"]
            # already on disk under its friendly name (e.g. after a ledger reset)?
            if aid in nmap and nmap[aid] in existing:
                mark_synced(eff, aid, nmap[aid])
                self.progress["skipped"] += 1
                continue
            n += 1
            name = f"{base}-{n}.{self._ext_for(a)}"
            nmap[aid] = name
            candidates.append((a, name))
        if self._local and candidates:
            try:
                os.makedirs(folder, exist_ok=True)
            except Exception:
                pass
            _save_namemap(folder, nmap)
        if not candidates:
            return
        if self._local:
            await self._sync_tag_local(eff, folder, candidates)
        else:
            await self._sync_tag_ssh(eff, folder, candidates)

    @staticmethod
    def _ext_for(asset: dict) -> str:
        base = asset.get("originalFileName") or ""
        ext = base.rpartition(".")[2].lower() if "." in base else "png"
        return ext if (ext and len(ext) <= 5) else "png"

    @staticmethod
    def _copy_readable(src: str, dst: str):
        """Copy bytes, then force a world-readable mode (0664). The companion is
        an unprivileged LXC writing under a restrictive umask, so without this the
        files land 0600 and Samba (a different uid) can't serve them to clients."""
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o664)

    def _src_path(self, original_path: str) -> str | None:
        """Map an Immich asset originalPath to the companion's in-container path
        via the bind-mounted Immich storage."""
        pre = _immich_prefix()
        if original_path and original_path.startswith(pre):
            return _immich_src_root() + original_path[len(pre):]
        return None

    async def _sync_tag_local(self, eff: str, folder: str, candidates: list):
        """Direct local copy from the bind-mounted Immich library — no HTTP, no SSH."""
        existing = set(os.listdir(folder)) if os.path.isdir(folder) else set()
        to_copy = []
        for a, fn in candidates:
            if fn in existing:
                mark_synced(eff, a["id"], fn)
                self.progress["skipped"] += 1
            else:
                to_copy.append((a, fn))
        self.progress["dl_total"] = len(to_copy)
        self.progress["dl_done"] = 0
        if not to_copy:
            return
        try:
            os.makedirs(folder, exist_ok=True)
        except Exception as e:
            log.warning(f"sync: mkdir {folder} failed: {e}")
            self.progress["errors"] += len(to_copy)
            return
        sem = asyncio.Semaphore(_DL_CONCURRENCY)

        async def _cp(a, fn):
            async with sem:
                op = a.get("originalPath")
                if not op:
                    try:
                        op = (await self.immich.asset_info(a["id"])).get("originalPath")
                    except Exception:
                        op = None
                sp = self._src_path(op)
                ok = False
                if sp and os.path.isfile(sp):
                    try:
                        await asyncio.to_thread(self._copy_readable, sp,
                                                os.path.join(folder, fn))
                        ok = True
                    except Exception as e:
                        log.warning(f"sync: copy {a['id'][:8]} failed: {e}")
                else:
                    log.warning(f"sync: source missing for {a['id'][:8]} ({sp})")
                if ok:
                    mark_synced(eff, a["id"], fn)
                    self.progress["delivered"] += 1
                else:
                    self.progress["errors"] += 1
                self.progress["dl_done"] += 1

        await asyncio.gather(*[_cp(a, fn) for a, fn in to_copy])

    async def _sync_tag_ssh(self, eff: str, folder: str, candidates: list):
        """Fallback: download from Immich (HTTP) + rsync to the NAS over SSH."""
        existing = await self._remote_existing(folder)
        to_dl = []
        for a, fn in candidates:
            if fn in existing:
                mark_synced(eff, a["id"], fn)
                self.progress["skipped"] += 1
            else:
                to_dl.append((a, fn))
        self.progress["dl_total"] = len(to_dl)
        self.progress["dl_done"] = 0
        if not to_dl:
            return
        with tempfile.TemporaryDirectory(prefix="sync_") as td:
            sem = asyncio.Semaphore(_DL_CONCURRENCY)
            got: list[tuple[str, str]] = []

            async def _dl(a, fn):
                async with sem:
                    p = Path(td) / fn
                    try:
                        await self.immich.download_original(a["id"], p)
                    except Exception as e:
                        log.warning(f"sync: dl {a['id'][:8]} failed: {e}")
                        self.progress["errors"] += 1
                        self.progress["dl_done"] += 1
                        return
                    if p.is_file() and p.stat().st_size > 0:
                        got.append((a["id"], fn))
                    else:
                        self.progress["errors"] += 1
                    self.progress["dl_done"] += 1

            await asyncio.gather(*[_dl(a, fn) for a, fn in to_dl])
            if not got:
                return
            if await self._rsync_dir(td, folder):
                for aid, fn in got:
                    mark_synced(eff, aid, fn)
                self.progress["delivered"] += len(got)

    async def _assets_with(self, tag_id: str, ready_ids: list) -> list[dict]:
        """Union of assets matching (tag AND ready) for each ready tag — i.e.
        anything carrying the tag plus EITHER 'upscaled' or 'upscale-res'."""
        seen, out = set(), []
        for rid in ready_ids:
            page = 1
            while True:
                res = await self.immich.search_metadata(
                    tag_ids=[tag_id, rid], page=page, size=250,
                    with_exif=False, with_stacked=True)
                for it in res.get("items") or []:
                    aid = it.get("id")
                    if aid and aid not in seen:
                        seen.add(aid)
                        out.append(it)
                np = res.get("nextPage")
                if not np:
                    break
                try:
                    page = int(np)
                except (TypeError, ValueError):
                    break
        return out

    def _name_for(self, asset: dict, aid: str) -> str:
        base = asset.get("originalFileName") or ""
        ext = base.rpartition(".")[2].lower() if "." in base else "png"
        if not ext or len(ext) > 5:
            ext = "png"
        return f"{aid}.{ext}"
