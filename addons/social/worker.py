"""Background sync: one gallery-dl process at a time PER SITE (Instagram rate-limits hard; X too).

Each run downloads one account into <storage>/<site>/<handle>/ with:
  - a per-site download archive (data/archive-<site>.sqlite3) so nothing is fetched twice, even after
    a file is deleted from the library;
  - gallery-dl's metadata post-processor writing <dir>/.meta/<file>.json (post url, date, caption,
    size) which the indexer reads into the DB;
  - skip=abort:N once an account has had a complete pass, so a routine sync stops at the first run
    of already-archived posts instead of walking the whole history again.
"""

import asyncio
import collections
import json
import logging
import os
import re
import time
from datetime import datetime, timezone

import db

log = logging.getLogger("social.worker")

HERE = os.path.dirname(os.path.abspath(__file__))
GDL = os.path.join(HERE, ".venv", "bin", "gallery-dl")
# Bluesky runs through a wrapper that can fetch JPEGs from the CDN instead of the throttled PDS
GDL_BLUESKY = [os.path.join(HERE, ".venv", "bin", "python"), os.path.join(HERE, "gdl_bluesky.py")]
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v"}
MEDIA_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"} | VIDEO_EXTS
ABORT_AFTER = 12        # consecutive already-archived files that end an incremental sync (covers pinned posts)
FILENAMES = {
    "instagram": "{post_shortcode}_{num}.{extension}",
    "twitter": "{tweet_id}_{num}.{extension}",
    # gallery posts: every image has its own id, num = position in the gallery
    "redgifs": "{id}_{num}.{extension}",
    "bluesky": "{post_id}_{num}.{extension}",
}
IMAGE_ONLY_FILTER = "extension in ('jpg', 'jpeg', 'png', 'webp', 'gif')"


def account_url(site: str, handle: str) -> str:
    if site == "instagram":
        return f"https://www.instagram.com/{handle}/"
    if site == "redgifs":
        return f"https://www.redgifs.com/users/{handle}"
    if site == "bluesky":
        return f"https://bsky.app/profile/{handle}/media"
    return f"https://x.com/{handle}/media"


def normalize_handle(site: str, raw: str) -> str:
    """'@name', 'name', or a profile URL -> 'name'. Empty string when it isn't a plausible handle."""
    s = (raw or "").strip()
    m = re.search(r"(?:instagram\.com|twitter\.com|x\.com|redgifs\.com/users|bsky\.app/profile)/+([^/?#]+)", s, re.I)
    if m:
        s = m.group(1)
    s = s.lstrip("@").strip()
    if site == "bluesky":
        # a handle is a domain (name.bsky.social, or a custom one like nasa.gov) or a did:plc id;
        # a bare "name" means the default name.bsky.social
        if re.match(r"^did:plc:[a-z2-7]{24}$", s):
            return s
        s = s.lower()
        if "." not in s:
            s += ".bsky.social"
        return s if re.match(r"^[a-z0-9]([a-z0-9-]{0,62}\.)+[a-z][a-z0-9-]{0,62}$", s) and len(s) <= 253 else ""
    pat = {"instagram": r"^[A-Za-z0-9._]{1,30}$", "redgifs": r"^[A-Za-z0-9._-]{1,64}$"}.get(site, r"^[A-Za-z0-9_]{1,15}$")
    return s if re.match(pat, s) else ""


def parse_cookies(text: str) -> dict:
    """Accepts a Netscape cookies.txt, a JSON export ([{name, value}] or {name: value}), or a
    'name=value; name2=value2' header string. -> {name: value}"""
    text = (text or "").strip()
    if not text:
        return {}
    if text[:1] in "[{":
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                return {str(k): str(v) for k, v in data.items()}
            return {str(c["name"]): str(c["value"]) for c in data if isinstance(c, dict) and "name" in c}
        except Exception:
            pass
    out = {}
    if "\t" in text:
        for line in text.splitlines():
            if not line.strip() or (line.startswith("#") and not line.startswith("#HttpOnly_")):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                out[parts[5]] = parts[6].strip()
        if out:
            return out
    for part in re.split(r";\s*|\n", text):
        if "=" in part:
            k, v = part.split("=", 1)
            if k.strip():
                out[k.strip()] = v.strip()
    return out


# redgifs: anonymous API token. bluesky: anonymous works for most profiles; the optional login is an app
# password kept in the same never-returned store as cookies, as "handle=...; app_password=...".
REQUIRED_COOKIES = {"instagram": ("sessionid",), "twitter": ("auth_token", "ct0"), "redgifs": (), "bluesky": ()}


def _sleep_value(spec: str):
    m = re.match(r"^\s*([\d.]+)\s*(?:-\s*([\d.]+))?\s*$", spec or "")
    if not m:
        return None
    a = float(m.group(1))
    return [a, float(m.group(2))] if m.group(2) else a


def _ts(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s[:19], fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            pass
    return None


class SiteRunner:
    def __init__(self, site: str):
        self.site = site
        self.queue: collections.deque[int] = collections.deque()
        self.current: dict | None = None      # {account_id, handle, started, downloaded, skipped}
        self.proc: asyncio.subprocess.Process | None = None
        self.log: collections.deque[str] = collections.deque(maxlen=400)
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.runs_completed = 0
        self.cancel_requested = False

    # ---- state ----
    @property
    def paused(self) -> bool:
        return db.get_setting(f"{self.site}.paused") == "1"

    def status(self) -> dict:
        cur = dict(self.current) if self.current else None
        return {"paused": self.paused, "current": cur, "queue": list(self.queue),
                "runs_completed": self.runs_completed}

    def _log(self, line: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log.append(f"{stamp} {line}")

    def enqueue(self, acct_id: int, front: bool = False) -> None:
        if self.current and self.current.get("account_id") == acct_id:
            return
        if acct_id in self.queue:
            if not front:
                return
            self.queue.remove(acct_id)
        if front:
            self.queue.appendleft(acct_id)
        else:
            self.queue.append(acct_id)
        self.wake.set()

    async def cancel(self) -> None:
        self.queue.clear()
        if self.proc and self.proc.returncode is None:
            self.cancel_requested = True
            self.proc.terminate()

    # ---- loop ----
    async def loop(self) -> None:
        while True:
            try:
                if self.paused or not self.queue:
                    self.wake.clear()
                    try:
                        await asyncio.wait_for(self.wake.wait(), timeout=30)
                    except asyncio.TimeoutError:
                        pass
                    continue
                acct_id = self.queue.popleft()
                acct = await asyncio.to_thread(db.get_account, acct_id)
                if not acct:
                    continue
                await self.run_account(acct)
            except asyncio.CancelledError:
                raise
            except Exception as e:   # never let one bad run kill the loop
                log.exception("[%s] loop error", self.site)
                self._log(f"loop error: {e}")
                await asyncio.sleep(5)

    def _config(self, settings: dict, limited: bool) -> dict:
        site = self.site
        ex: dict = {
            "archive": os.path.join(db.DATA_DIR, f"archive-{site}.sqlite3"),
            "filename": FILENAMES[site],
            "videos": settings.get("include_videos") == "1",
            "postprocessors": [
                {"name": "metadata", "event": "file", "directory": ".meta", "mode": "json"},
                {"name": "mtime"},
            ],
        }
        sl = _sleep_value(settings.get(f"{site}.sleep", ""))
        if sl is not None:
            ex["sleep-request"] = sl
        cookies = parse_cookies(settings.get(f"{site}.cookies", ""))
        if site == "bluesky":
            if cookies.get("handle") and cookies.get("app_password"):
                ex["username"], ex["password"] = cookies["handle"], cookies["app_password"]
        elif cookies:
            ex["cookies"] = cookies
        if site == "instagram":
            ex["include"] = settings.get("instagram.include") or "posts"
        elif site == "bluesky":
            ex["reposts"] = settings.get("bluesky.reposts") == "1"
        elif site == "redgifs":
            # RedGIFs is mostly video; "videos" is not a redgifs option, so images-only is a file filter
            # (type-2 image posts arrive as .jpg, clips as .mp4)
            if settings.get("include_videos") != "1":
                ex["image-filter"] = IMAGE_ONLY_FILTER
        else:
            ex["retweets"] = settings.get("twitter.retweets") == "1"
            ex["text-tweets"] = False
            ex["cards"] = False
        return {"extractor": {site: ex}, "output": {"mode": "pipe", "progress": False}}

    async def run_account(self, acct: dict) -> None:
        site, handle, acct_id = self.site, acct["handle"], acct["id"]
        settings = await asyncio.to_thread(db.get_settings)
        storage = settings.get("storage_path") or db.DEFAULTS["storage_path"]
        target = os.path.join(storage, site, handle)
        os.makedirs(target, exist_ok=True)
        limit = int(settings.get("first_sync_limit") or 0)
        full_pass = not acct["complete"]
        cfg_path = os.path.join(db.DATA_DIR, f"run-{site}.json")
        cfg = self._config(settings, limited=bool(full_pass and limit))
        if not full_pass:
            # Stop at the first run of already-archived files. Capped at what the library holds: after a
            # first sync limited to N files, only N archived files sit on top of the never-fetched older
            # history, and a bigger threshold would walk straight through them into it. The floor of 4
            # covers Instagram's up-to-3 pinned posts, which always lead the feed (and so were fetched).
            have = len(await asyncio.to_thread(db.known_rels, acct_id))
            cfg["extractor"][site]["skip"] = f"abort:{max(4, min(ABORT_AFTER, have))}"
        fd = os.open(cfg_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)   # holds the login cookies
        with os.fdopen(fd, "w") as fh:
            json.dump(cfg, fh)
        args = [*(GDL_BLUESKY if site == "bluesky" else [GDL]), "--config-ignore", "-c", cfg_path, "-D", target]
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        if site == "bluesky" and settings.get("bluesky.fast", "1") == "1":
            env["AILAB_BSKY_CDN"] = "1"
        if full_pass and limit > 0:
            args += ["--range", f"1-{limit}"]
        args.append(account_url(site, handle))

        self.current = {"account_id": acct_id, "handle": handle, "started": time.time(),
                        "downloaded": 0, "skipped": 0, "full_pass": full_pass, "last_file": ""}
        self.cancel_requested = False
        await asyncio.to_thread(db.update_account, acct_id, last_status="running", last_error=None)
        self._log(f"sync @{handle} ({'full history' + (f', first {limit}' if limit else '') if full_pass else 'new posts only'})")
        errors: list[str] = []
        rc = -1
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=env)

            async def read_out():
                assert self.proc and self.proc.stdout
                async for raw in self.proc.stdout:
                    line = raw.decode("utf-8", "replace").rstrip("\n")
                    if line.startswith("# "):
                        self.current["skipped"] += 1
                    elif line.startswith("/"):
                        self.current["downloaded"] += 1
                        self.current["last_file"] = os.path.basename(line)
                        await asyncio.to_thread(self._index_file, acct_id, storage, line)

            async def read_err():
                assert self.proc and self.proc.stderr
                async for raw in self.proc.stderr:
                    line = raw.decode("utf-8", "replace").rstrip("\n")
                    if not line:
                        continue
                    self._log(line)
                    if "[error]" in line:
                        errors.append(line.split("[error]", 1)[1].strip())

            await asyncio.gather(read_out(), read_err())
            rc = await self.proc.wait()
        except Exception as e:
            errors.append(str(e))
            log.exception("[%s] run @%s failed", site, handle)
        finally:
            self.proc = None
        # pick up anything the line parser missed (meta written late, earlier crash, manual copies)
        new_from_scan = await asyncio.to_thread(self.rescan_account, acct_id, handle, storage)
        got = self.current["downloaded"]
        cancelled = self.cancel_requested
        status = "cancelled" if cancelled else ("ok" if rc == 0 else ("partial" if got else "error"))
        fields = {"last_synced_at": time.time(), "last_status": status, "last_new": got,
                  "last_error": ("; ".join(dict.fromkeys(errors))[:500] or (None if rc == 0 else f"gallery-dl exit {rc}"))
                  if not cancelled else None}
        if rc == 0 and full_pass and not cancelled:
            fields["complete"] = 1
        await asyncio.to_thread(db.update_account, acct_id, **fields)
        self._log(f"@{handle}: {status}, {got} new, {self.current['skipped']} already had"
                  + (f", {new_from_scan} indexed by rescan" if new_from_scan else "") + f" (exit {rc})")
        self.runs_completed += 1
        self.current = None

    # ---- indexing ----
    def _row_for(self, acct_id: int, storage: str, path: str) -> dict | None:
        ext = os.path.splitext(path)[1].lower()
        if ext not in MEDIA_EXTS or not os.path.isfile(path):
            return None
        meta = {}
        mp = os.path.join(os.path.dirname(path), ".meta", os.path.basename(path) + ".json")
        try:
            with open(mp, encoding="utf-8") as fh:
                meta = json.load(fh)
        except Exception:
            pass
        if self.site == "bluesky":
            post_id = meta.get("post_id")
            author = (meta.get("author") or {}).get("handle") if isinstance(meta.get("author"), dict) else None
            post_url = f"https://bsky.app/profile/{author}/post/{post_id}" if post_id and author else None
            caption = meta.get("text") or None
            posted = _ts(meta.get("date") or meta.get("createdAt"))
        elif self.site == "redgifs":
            post_id = meta.get("id")
            post_url = f"https://www.redgifs.com/watch/{post_id}" if post_id else None
            tags = meta.get("tags") or []
            caption = " · ".join(x for x in (meta.get("description") or "", ", ".join(tags)) if x) or None
            posted = _ts(meta.get("createDate") or meta.get("date"))
        elif self.site == "instagram":
            post_id = meta.get("post_shortcode") or meta.get("shortcode")
            post_url = meta.get("post_url") or (f"https://www.instagram.com/p/{post_id}/" if post_id else None)
            caption = meta.get("description")
            posted = _ts(meta.get("post_date") or meta.get("date"))
        else:
            post_id = str(meta.get("tweet_id") or "") or None
            user = (meta.get("author") or meta.get("user") or {}).get("name") if isinstance(meta.get("author") or meta.get("user"), dict) else None
            post_url = f"https://x.com/{user or 'i'}/status/{post_id}" if post_id else None
            caption = meta.get("content")
            posted = _ts(meta.get("date"))
        if not post_id:
            post_id = os.path.basename(path).split("_")[0]
        st = os.stat(path)
        return {
            "site": self.site, "account_id": acct_id, "rel": os.path.relpath(path, storage),
            "post_id": post_id, "post_url": post_url, "posted_at": posted or st.st_mtime,
            "caption": caption, "width": meta.get("width"), "height": meta.get("height"),
            "size": st.st_size, "is_video": 1 if ext in VIDEO_EXTS else 0, "added_at": time.time(),
        }

    def _index_file(self, acct_id: int, storage: str, path: str) -> bool:
        row = self._row_for(acct_id, storage, path)
        if not row:
            return False
        if not row["is_video"] and not row["width"]:
            try:
                from PIL import Image
                with Image.open(path) as im:
                    row["width"], row["height"] = im.size
            except Exception:
                pass
        return db.insert_media(row)

    def rescan_account(self, acct_id: int, handle: str, storage: str) -> int:
        """Index files on disk that the DB lacks; drop rows whose file is gone. -> rows added."""
        target = os.path.join(storage, self.site, handle)
        known = db.known_rels(acct_id)
        seen = set()
        added = 0
        try:
            names = os.listdir(target)
        except FileNotFoundError:
            names = []
        for name in names:
            p = os.path.join(target, name)
            rel = os.path.relpath(p, storage)
            seen.add(rel)
            if rel in known or name.startswith(".") or name.endswith(".part"):
                continue
            if self._index_file(acct_id, storage, p):
                added += 1
        gone = [r for r in known if r not in seen]
        if gone:
            db.delete_missing(acct_id, gone)
        return added


class Worker:
    def __init__(self):
        self.runners = {s: SiteRunner(s) for s in db.SITES}
        self._tasks: list[asyncio.Task] = []

    def start(self) -> None:
        for r in self.runners.values():
            self._tasks.append(asyncio.create_task(r.loop()))
        self._tasks.append(asyncio.create_task(self.scheduler()))

    async def stop(self) -> None:
        for r in self.runners.values():
            await r.cancel()
        for t in self._tasks:
            t.cancel()

    async def scheduler(self) -> None:
        """Every minute: queue each enabled account whose last sync is older than the poll interval."""
        await asyncio.sleep(20)
        while True:
            try:
                hours = float(await asyncio.to_thread(db.get_setting, "poll_interval_h") or 12)
                if hours > 0:
                    now = time.time()
                    for site, runner in self.runners.items():
                        for a in await asyncio.to_thread(db.list_accounts, site):
                            if a["enabled"] and (not a["last_synced_at"] or now - a["last_synced_at"] > hours * 3600):
                                runner.enqueue(a["id"])
            except Exception:
                log.exception("scheduler")
            await asyncio.sleep(60)


worker = Worker()
