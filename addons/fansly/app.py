"""
Multi-service scraper webui — Fansly, Coomer, Kemono.

Coomer/Kemono use a per-link batch model:
  - User types canonical usernames (one per line) + picks a default source.
  - "Discover" hits /api/v1/<service>/user/<name>/links on the relevant site
    and returns the user's linked accounts across services.
  - User picks which linked accounts to download from (checkboxes).
  - "Run" iterates the enabled (canonical_user, link_service, link_id, link_name)
    tuples and spawns coomer-cli per item with -d /<root>/<canonical>/<svc>_<name>/.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import subprocess
import tempfile
import time
import zipfile
from collections import Counter, deque
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from ruamel.yaml import YAML

try:
    import psycopg  # type: ignore
except ImportError:
    psycopg = None  # type: ignore

try:
    import cloudscraper  # type: ignore
except ImportError:
    cloudscraper = None  # type: ignore


WEBUI_ROOT = Path("/opt/ai-lab/addons/fansly")
STATIC_DIR = WEBUI_ROOT / "static"
COOMER_CLI = Path("/opt/coomer-cli")


SERVICES: dict[str, dict[str, Any]] = {
    "fansly": {
        "label": "Fansly",
        "kind": "daemon",
        "root": Path("/nas/zpoolalpha/fans"),
        "settings_file": WEBUI_ROOT / "settings-fansly.json",
        "systemd_unit": "fansly-scraper.service",
        "config_path": Path("/opt/fansly-scraper/config.yaml"),
    },
    "coomer": {
        "label": "Coomer",
        "kind": "oneshot",
        "root": Path("/nas/zpoolalpha/coomer"),
        "settings_file": WEBUI_ROOT / "settings-coomer.json",
        "queue_file": WEBUI_ROOT / "queue-coomer.json",
        "cli_python": COOMER_CLI / "venv" / "bin" / "python",
        "cli_script": COOMER_CLI / "coomer.py",
        "domain": "coomer.st",
        "default_service": "onlyfans",
        "services": ["onlyfans", "fansly", "candfans", "manyvids", "fansale"],
    },
    "kemono": {
        "label": "Kemono",
        "kind": "oneshot",
        "root": Path("/nas/zpoolalpha/kemono"),
        "settings_file": WEBUI_ROOT / "settings-kemono.json",
        "queue_file": WEBUI_ROOT / "queue-kemono.json",
        "cli_python": COOMER_CLI / "venv" / "bin" / "python",
        "cli_script": COOMER_CLI / "coomer.py",
        "domain": "kemono.cr",
        "default_service": "patreon",
        "services": ["patreon", "fanbox", "gumroad", "discord", "fantia",
                     "afdian", "boosty", "dlsite", "subscribestar", "candfans"],
    },
    "coomerfans": {
        "label": "Coomerfans",
        "kind": "oneshot",
        "root": Path("/nas/zpoolalpha/coomerfans"),
        "settings_file": WEBUI_ROOT / "settings-coomerfans.json",
        "queue_file": WEBUI_ROOT / "queue-coomerfans.json",
        # Coomerfans uses our own scraper (not coomer-cli), so the cli_*
        # fields point at scrape.py + the addon venv (where requests + bs4 live).
        "cli_python": WEBUI_ROOT / ".venv" / "bin" / "python",
        "cli_script": Path("/opt/coomerfans-scraper/scrape.py"),
        "domain": "coomerfans.com",
        "default_service": "onlyfans",
        "services": ["onlyfans", "fansly", "candfans"],
        # No /api/v1 discovery on coomerfans — each URL is a standalone profile.
        "no_discovery": True,
    },
}


def get_service(name: str) -> dict[str, Any]:
    if name not in SERVICES:
        raise HTTPException(404, f"Unknown service: {name}")
    return SERVICES[name]


# Generic helpers ─────────────────────────────────────────────────

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
URL_RE = re.compile(r"https?://([^/]+)/([\w-]+)/user/([^/?#]+)", re.I)


def now_hms() -> str:
    return datetime.now().strftime("%H:%M:%S")


def classify(msg: str) -> str:
    m = msg.lower()
    if "error" in m or "failed" in m or "traceback" in m or "exception" in m:
        return "error"
    if "warn" in m:
        return "warn"
    if "skip" in m or "already exists" in m or "duplicate" in m or "exists, skipping" in m:
        return "skip"
    if "downloading" in m or "downloaded" in m or "saving" in m or "saved" in m:
        return "download"
    return "info"


def safe_under(root: Path, rel: str) -> Path:
    rel = (rel or "").lstrip("/")
    root_resolved = root.resolve()
    p = (root_resolved / rel).resolve() if rel else root_resolved
    if not (str(p) == str(root_resolved) or str(p).startswith(str(root_resolved) + os.sep)):
        raise HTTPException(403, "Path traversal blocked")
    if not p.exists():
        raise HTTPException(404, f"Not found: {rel}")
    return p


def folder_stats(folder: Path) -> tuple[int, int]:
    n, total = 0, 0
    for f in folder.rglob("*"):
        if f.is_file():
            try:
                total += f.stat().st_size
                n += 1
            except OSError:
                pass
    return n, total


def load_settings(svc: str) -> dict[str, Any]:
    default = {"auto_zip_folders": True}
    f = SERVICES[svc]["settings_file"]
    if not f.exists():
        return default
    try:
        return {**default, **json.loads(f.read_text())}
    except Exception:
        return default


def save_settings(svc: str, d: dict[str, Any]) -> None:
    f = SERVICES[svc]["settings_file"]
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=2))
    os.replace(tmp, f)


# Queue management (per-user, per-link model) ─────────────────────

def _parse_input_token(token: str, default_service: str) -> tuple[str, str]:
    """Returns (username, service) for a raw textarea line.
    Accepted forms:
      - bare username        -> (token, default_service)
      - service:username     -> split on first ':'
      - full URL             -> extract from path
    """
    token = token.strip()
    if not token:
        return ("", default_service)
    m = URL_RE.search(token)
    if m:
        return (m.group(3), m.group(2).lower())
    if ":" in token:
        svc, name = token.split(":", 1)
        return (name.strip(), svc.strip().lower())
    return (token, default_service)


def load_queue(svc: str) -> dict[str, Any]:
    cfg = SERVICES[svc]
    default_service = cfg.get("default_service", "onlyfans")
    f = cfg.get("queue_file")
    base = {"users": [], "default_service": default_service, "extra_args": ""}
    if not f or not f.exists():
        return base
    try:
        d = json.loads(f.read_text())
    except Exception:
        return base

    # Back-compat: migrate old `urls:[...]` format on read
    if "urls" in d and "users" not in d:
        users = []
        for raw in d.get("urls", []):
            name, service = _parse_input_token(raw, default_service)
            if name:
                users.append({"input": name, "service": service, "links": []})
        d = {
            "users": users,
            "default_service": d.get("default_service", default_service),
            "extra_args": d.get("extra_args", ""),
        }

    d.setdefault("users", [])
    d.setdefault("default_service", default_service)
    d.setdefault("extra_args", "")
    return d


def save_queue(svc: str, d: dict[str, Any]) -> None:
    f = SERVICES[svc]["queue_file"]
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=2))
    os.replace(tmp, f)


# LogBus ─────────────────────────────────────────────────────────

class LogBus:
    def __init__(self, name: str, buffer_size: int = 300):
        self.name = name
        self.buffer: deque[dict[str, Any]] = deque(maxlen=buffer_size)
        self.subscribers: set[asyncio.Queue] = set()
        self.producer_task: asyncio.Task | None = None

    async def publish(self, payload: dict[str, Any]) -> None:
        self.buffer.append(payload)
        for q in list(self.subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    async def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=400)
        self.subscribers.add(q)
        for payload in list(self.buffer):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                break
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def ensure_producer(self, factory):
        if self.producer_task is None or self.producer_task.done():
            self.producer_task = asyncio.create_task(factory())


LOG_BUSES: dict[str, LogBus] = {name: LogBus(name) for name in SERVICES}


async def fansly_journal_tail():
    bus = LOG_BUSES["fansly"]
    proc = await asyncio.create_subprocess_exec(
        "journalctl", "-u", "fansly-scraper.service",
        "-f", "-n", "60", "-o", "json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            try:
                obj = json.loads(line)
            except Exception:
                continue
            msg = obj.get("MESSAGE", "")
            if isinstance(msg, list):
                try:
                    msg = bytes(msg).decode("utf-8", "replace")
                except Exception:
                    continue
            msg = ANSI_RE.sub("", msg).strip()
            if not msg:
                continue
            ts_us = int(obj.get("__REALTIME_TIMESTAMP", "0") or 0)
            ts = (datetime.fromtimestamp(ts_us / 1_000_000).strftime("%H:%M:%S")
                  if ts_us else "")
            await bus.publish({"t": ts, "m": msg[:600], "k": classify(msg)})
    finally:
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


# RunController with batch support ────────────────────────────────

class RunController:
    def __init__(self, svc: str, bus: LogBus):
        self.svc = svc
        self.bus = bus
        self.current_proc: asyncio.subprocess.Process | None = None
        self.start_time: float | None = None
        self.end_time: float | None = None
        self.last_exit: int | None = None
        self.last_cmd: list[str] | None = None
        self.batch_total: int = 0
        self.batch_index: int = 0
        self.cancel_requested: bool = False

    @property
    def is_running(self) -> bool:
        return self.current_proc is not None and self.current_proc.returncode is None

    @property
    def state_snapshot(self) -> dict[str, Any]:
        s = {
            "running": self.is_running,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "last_exit": self.last_exit,
            "last_cmd": self.last_cmd,
            "batch_total": self.batch_total,
            "batch_index": self.batch_index,
        }
        if self.is_running and self.start_time:
            s["elapsed_seconds"] = time.time() - self.start_time
        return s

    async def start_batch(self, items: list[tuple[list[str], str]], cwd: str | None = None) -> None:
        """items: list of (cmd, label) tuples to run sequentially."""
        if self.is_running:
            raise HTTPException(409, "A run is already in progress for this service")
        if not items:
            raise HTTPException(400, "Nothing to run — queue empty or no links enabled")
        self.cancel_requested = False
        self.start_time = time.time()
        self.end_time = None
        self.batch_total = len(items)
        self.batch_index = 0
        await self.bus.publish({
            "t": now_hms(),
            "m": f"== BATCH START: {len(items)} job{'s' if len(items) != 1 else ''} ==",
            "k": "info",
        })
        asyncio.create_task(self._run_batch(items, cwd))

    async def _run_batch(self, items: list[tuple[list[str], str]], cwd: str | None) -> None:
        last_rc = 0
        try:
            for i, (cmd, label) in enumerate(items):
                if self.cancel_requested:
                    await self.bus.publish({
                        "t": now_hms(),
                        "m": f"== BATCH CANCELLED at {i}/{len(items)} ==",
                        "k": "warn",
                    })
                    break
                self.batch_index = i + 1
                self.last_cmd = cmd
                await self.bus.publish({
                    "t": now_hms(),
                    "m": f"== [{i+1}/{len(items)}] STARTING: {label} ==",
                    "k": "info",
                })
                self.current_proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=cwd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    env={**os.environ, "PYTHONUNBUFFERED": "1", "TERM": "dumb"},
                )
                while True:
                    line = await self.current_proc.stdout.readline()
                    if not line:
                        break
                    txt = ANSI_RE.sub("", line.decode("utf-8", "replace")).rstrip()
                    if not txt:
                        continue
                    await self.bus.publish({
                        "t": now_hms(),
                        "m": txt[:600],
                        "k": classify(txt),
                    })
                rc = await self.current_proc.wait()
                last_rc = rc
                await self.bus.publish({
                    "t": now_hms(),
                    "m": f"== [{i+1}/{len(items)}] {label} exit={rc} ==",
                    "k": "info" if rc == 0 else "warn",
                })
        except Exception as e:
            await self.bus.publish({
                "t": now_hms(),
                "m": f"batch error: {e}",
                "k": "error",
            })
            last_rc = -1
        finally:
            self.last_exit = last_rc
            self.end_time = time.time()
            self.current_proc = None
            dur = (self.end_time - self.start_time) if self.start_time else 0
            await self.bus.publish({
                "t": now_hms(),
                "m": f"== BATCH FINISHED: {self.batch_index}/{self.batch_total} jobs, {dur:.1f}s ==",
                "k": "info" if last_rc == 0 else "error",
            })

    async def cancel(self) -> bool:
        if not self.is_running:
            return False
        self.cancel_requested = True
        await self.bus.publish({"t": now_hms(), "m": "== CANCEL REQUESTED ==", "k": "warn"})
        try:
            assert self.current_proc is not None
            self.current_proc.terminate()
            try:
                await asyncio.wait_for(self.current_proc.wait(), timeout=10)
            except asyncio.TimeoutError:
                self.current_proc.kill()
        except Exception:
            pass
        return True


RUNNERS: dict[str, RunController] = {
    name: RunController(name, LOG_BUSES[name])
    for name, cfg in SERVICES.items()
    if cfg["kind"] == "oneshot"
}


# Link-discovery helpers ─────────────────────────────────────────

def _coomer_headers(domain: str) -> dict[str, str]:
    return {"Accept": "text/css", "Referer": f"https://{domain}/"}


def _coomer_get(svc_tab: str, path: str):
    """GET helper that uses the DDoS-Guard Accept:text/css bypass."""
    if cloudscraper is None:
        raise HTTPException(500, "cloudscraper not installed in webui venv")
    domain = SERVICES[svc_tab]["domain"]
    scraper = cloudscraper.create_scraper(browser={"browser": "chrome", "platform": "linux"})
    return scraper.get(f"https://{domain}{path}", headers=_coomer_headers(domain), timeout=20)


def _fetch_profile(svc_tab: str, service: str, username: str) -> dict[str, Any] | None:
    """Returns the user profile dict, or None if the user doesn't exist."""
    r = _coomer_get(svc_tab, f"/api/v1/{service}/user/{username}/profile")
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise HTTPException(502, f"Upstream returned HTTP {r.status_code} for /profile")
    try:
        return r.json()
    except Exception as e:
        raise HTTPException(502, f"Upstream /profile returned non-JSON: {e}")


def _fetch_links(svc_tab: str, service: str, username: str) -> list[dict[str, Any]]:
    r = _coomer_get(svc_tab, f"/api/v1/{service}/user/{username}/links")
    if r.status_code == 404:
        return []
    if r.status_code != 200:
        raise HTTPException(502, f"Upstream returned HTTP {r.status_code} for /links")
    try:
        return r.json()
    except Exception as e:
        raise HTTPException(502, f"Upstream /links returned non-JSON: {e}")


# Per-site creators-list cache. The full list is ~6 MB per site; we fetch
# lazily on first search and refresh every 6 hours.
_CREATORS_CACHE: dict[str, dict[str, Any]] = {}
_CREATORS_TTL = 6 * 3600


def _fetch_all_creators(svc_tab: str) -> list[dict[str, Any]]:
    cached = _CREATORS_CACHE.get(svc_tab)
    if cached and (time.time() - cached["t"]) < _CREATORS_TTL:
        return cached["data"]
    r = _coomer_get(svc_tab, "/api/v1/creators")
    if r.status_code != 200:
        raise HTTPException(502, f"Could not load /api/v1/creators: HTTP {r.status_code}")
    try:
        data = r.json()
    except Exception as e:
        raise HTTPException(502, f"/api/v1/creators not JSON: {e}")
    _CREATORS_CACHE[svc_tab] = {"t": time.time(), "data": data}
    return data


def _search_creators(svc_tab: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
    """Case-insensitive ranked search across all creators on the given site.
    Score:
      100 = exact match on name or id (case-insensitive)
       80 = name or id startswith query
       50 = name or id contains query
    Returns top N by descending score, ties broken by name."""
    try:
        creators = _fetch_all_creators(svc_tab)
    except HTTPException:
        return []
    q = query.lower().strip()
    if not q:
        return []
    scored: list[tuple[int, str, dict[str, Any]]] = []
    for c in creators:
        name = (c.get("name") or "").lower()
        cid = (c.get("id") or "").lower()
        if name == q or cid == q:
            score = 100
        elif name.startswith(q) or cid.startswith(q):
            score = 80
        elif q in name or q in cid:
            score = 50
        else:
            continue
        scored.append((score, c.get("name") or "", c))
    scored.sort(key=lambda x: (-x[0], x[1].lower()))
    return [c for _, _, c in scored[:limit]]


# Per-link command builder ────────────────────────────────────────

def _link_url(svc_tab: str, link: dict[str, Any]) -> str:
    domain = SERVICES[svc_tab]["domain"]
    target = str(link.get("id") or link.get("name"))
    return f"https://{domain}/{link['service']}/user/{target}"


def _build_per_link_commands(svc: str) -> list[tuple[list[str], str]]:
    cfg = SERVICES[svc]
    q = load_queue(svc)
    items: list[tuple[list[str], str]] = []
    extra = (q.get("extra_args") or "").strip()
    extra_parts = extra.split() if extra else []

    for user in q.get("users", []):
        canonical = user.get("input", "").strip()
        if not canonical:
            continue
        for link in user.get("links", []):
            if not link.get("enabled"):
                continue
            try:
                subname = f"{link['service']}_{link['name']}"
                # sanitize for filesystem (avoid path traversal characters)
                subname_safe = re.sub(r"[^A-Za-z0-9._-]", "_", subname)
                canonical_safe = re.sub(r"[^A-Za-z0-9._-]", "_", canonical)
            except KeyError:
                continue
            outdir = cfg["root"] / canonical_safe / subname_safe
            outdir.mkdir(parents=True, exist_ok=True)
            url = _link_url(svc, link)
            cmd = [
                str(cfg["cli_python"]),
                str(cfg["cli_script"]),
                url,
                "-d", str(outdir),
                "-t", "all",
                "-sv",
                "-n",
                "-x",
            ]
            cmd += extra_parts
            label = f"{canonical} / {link['service']}_{link['name']}"
            items.append((cmd, label))
    return items


# FastAPI ─────────────────────────────────────────────────────────

app = FastAPI(title="Scraper WebUI")
yaml = YAML()
yaml.preserve_quotes = True


# Generic per-service ───────────────────────────────────────────

@app.get("/api/{service}/info")
def service_info(service: str):
    cfg = get_service(service)
    info = {
        "name": service,
        "label": cfg["label"],
        "kind": cfg["kind"],
        "root": str(cfg["root"]),
    }
    if cfg["kind"] == "daemon":
        r = subprocess.run(
            ["systemctl", "is-active", cfg["systemd_unit"]],
            capture_output=True, text=True,
        )
        info["active"] = r.stdout.strip() == "active"
    else:
        info["run"] = RUNNERS[service].state_snapshot
        info["services"] = cfg.get("services", [])
        info["default_service"] = cfg.get("default_service", "onlyfans")
        info["domain"] = cfg.get("domain", "")
        info["has_discovery"] = not cfg.get("no_discovery", False)
    return info


@app.get("/api/{service}/browse")
def browse(service: str, path: str = ""):
    cfg = get_service(service)
    p = safe_under(cfg["root"], path)
    if not p.is_dir():
        raise HTTPException(400, "Not a directory")
    entries = []
    for child in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        try:
            st = child.stat()
        except OSError:
            continue
        is_dir = child.is_dir()
        ent = {"name": child.name, "type": "dir" if is_dir else "file", "mtime": int(st.st_mtime)}
        if is_dir:
            n, sz = folder_stats(child)
            ent["size"] = sz
            ent["file_count"] = n
        else:
            ent["size"] = st.st_size
        entries.append(ent)
    root = cfg["root"].resolve()
    rel = "" if p == root else str(p.relative_to(root))
    parent = None if p == root else ("" if p.parent == root else str(p.parent.relative_to(root)))
    return {"path": rel, "parent": parent, "entries": entries}


def stream_zip(folder: Path):
    buf = io.BytesIO()

    def flush():
        data = buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        return data

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
        for f in folder.rglob("*"):
            if not f.is_file():
                continue
            arcname = f.relative_to(folder.parent)
            try:
                zf.write(f, arcname=str(arcname))
            except OSError:
                continue
            if buf.tell() > 4 * 1024 * 1024:
                yield flush()
    tail = buf.getvalue()
    if tail:
        yield tail


@app.get("/api/{service}/download")
def download(service: str, path: str):
    cfg = get_service(service)
    p = safe_under(cfg["root"], path)
    if p.is_dir():
        if not load_settings(service).get("auto_zip_folders", True):
            raise HTTPException(409, "Folder download disabled. Enable 'Auto-zip folders' in Settings.")
        return StreamingResponse(
            stream_zip(p),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{p.name}.zip"'},
        )
    if not p.is_file():
        raise HTTPException(400, "Not a regular file or directory")
    return FileResponse(p, filename=p.name, media_type="application/octet-stream")


@app.get("/api/{service}/stats")
def stats(service: str):
    cfg = get_service(service)
    root = cfg["root"]
    creators = []
    type_counts: Counter = Counter()
    total_files = 0
    total_size = 0
    if root.exists():
        for creator_dir in sorted(root.iterdir()):
            if not creator_dir.is_dir():
                continue
            c_count = 0
            c_size = 0
            for f in creator_dir.rglob("*"):
                if not f.is_file():
                    continue
                try:
                    sz = f.stat().st_size
                except OSError:
                    continue
                c_count += 1
                c_size += sz
                ext = f.suffix.lower().lstrip(".") or "<no-ext>"
                type_counts[ext] += 1
            creators.append({"name": creator_dir.name, "file_count": c_count, "size_bytes": c_size})
            total_files += c_count
            total_size += c_size
    return {
        "creators": sorted(creators, key=lambda x: -x["size_bytes"]),
        "file_types": dict(type_counts.most_common(20)),
        "total_files": total_files,
        "total_size_bytes": total_size,
    }


_disk_cache: dict[str, dict[str, Any]] = {}


def _disk_stats_cached(service: str, ttl: int = 20):
    e = _disk_cache.get(service)
    now = time.time()
    if e and now - e["t"] < ttl:
        return e["data"]
    n, total = folder_stats(SERVICES[service]["root"])
    data = {"file_count": n, "bytes_total": total}
    _disk_cache[service] = {"t": now, "data": data}
    return data


@app.get("/api/{service}/live-stats")
def live_stats(service: str):
    cfg = get_service(service)
    out: dict[str, Any] = {"service": service, "disk": _disk_stats_cached(service)}
    if cfg["kind"] == "daemon":
        out["db"] = _fansly_db_stats()
    else:
        q = load_queue(service)
        out["run"] = RUNNERS[service].state_snapshot
        if cfg.get("no_discovery"):
            # Flat URL list — queue_count is the number of targets
            tokens = [u.get("input","").strip() for u in q.get("users",[]) if u.get("input")]
            tokens += [u.strip() for u in (q.get("urls") or []) if u and u.strip()]
            tokens = list(dict.fromkeys(tokens))
            out["queue_count"] = len(tokens)
            out["user_count"] = len(tokens)
        else:
            enabled = sum(1 for u in q.get("users", []) for l in u.get("links", []) if l.get("enabled"))
            out["queue_count"] = enabled
            out["user_count"] = len(q.get("users", []))
    return out


def _fansly_db_stats():
    if psycopg is None:
        return {"available": False, "error": "psycopg not installed"}
    try:
        pw = open("/root/.fansly-pg-pass").read().strip()
    except OSError:
        return {"available": False, "error": "no PG password file"}
    dsn = f"postgresql://fansly:{pw}@127.0.0.1:5432/fansly"
    try:
        with psycopg.connect(dsn, connect_timeout=2) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM accounts")
                accounts = cur.fetchone()[0]
                cur.execute("SELECT COUNT(*) FROM media")
                media_total = cur.fetchone()[0]
                cur.execute("SELECT COUNT(*) FROM media WHERE is_downloaded")
                media_downloaded = cur.fetchone()[0]
                cur.execute("SELECT COUNT(*) FROM posts")
                posts = cur.fetchone()[0]
                cur.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='media' AND "
                    "lower(column_name) IN "
                    "('createdat','created_at','created','updatedat','updated_at') "
                    "ORDER BY CASE lower(column_name) "
                    "WHEN 'createdat' THEN 1 WHEN 'created_at' THEN 2 "
                    "WHEN 'created' THEN 3 ELSE 4 END LIMIT 1"
                )
                row = cur.fetchone()
                created_col = row[0] if row else None
                if isinstance(created_col, (bytes, bytearray)):
                    created_col = created_col.decode("utf-8", "replace")
                rate_1m = None
                if created_col:
                    qcol = '"' + created_col.replace('"', "") + '"'
                    cur.execute("SELECT COUNT(*) FROM media WHERE " + qcol
                                + " >= NOW() - INTERVAL '1 minute'")
                    rate_1m = cur.fetchone()[0]
                return {
                    "available": True,
                    "accounts": accounts,
                    "media_total": media_total,
                    "media_downloaded": media_downloaded,
                    "posts": posts,
                    "rate_1m": rate_1m,
                }
    except Exception as e:
        return {"available": False, "error": str(e)[:200]}


@app.get("/api/{service}/settings")
def get_settings(service: str):
    get_service(service)
    return load_settings(service)


@app.put("/api/{service}/settings")
def put_settings(service: str, body: dict = Body(...)):
    get_service(service)
    s = load_settings(service)
    for k, v in body.items():
        if k in ("auto_zip_folders",) and isinstance(v, bool):
            s[k] = v
    save_settings(service, s)
    return s


@app.get("/api/{service}/log-stream")
async def log_stream(service: str):
    cfg = get_service(service)
    bus = LOG_BUSES[service]
    if cfg["kind"] == "daemon" and service == "fansly":
        bus.ensure_producer(fansly_journal_tail)

    async def gen():
        q = await bus.subscribe()
        try:
            yield "event: ready\ndata: {}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=30)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(payload)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Fansly-only ───────────────────────────────────────────────────

@app.get("/api/fansly/creators")
def get_creators():
    cfg = SERVICES["fansly"]
    parsed = yaml.load(cfg["config_path"].read_text())
    tc = parsed.get("targeted_creator", {})
    return {
        "usernames": [str(u) for u in (tc.get("usernames") or [])],
        "use_following": bool(tc.get("use_following", False)),
        "use_following_with_pagination": bool(tc.get("use_following_with_pagination", False)),
    }


class CreatorsUpdate(BaseModel):
    usernames: list[str]
    use_following: bool = False
    use_following_with_pagination: bool = False
    restart_scraper: bool = True


@app.put("/api/fansly/creators")
def put_creators(body: CreatorsUpdate):
    cfg = SERVICES["fansly"]
    config_path = cfg["config_path"]
    parsed = yaml.load(config_path.read_text())
    parsed["targeted_creator"]["usernames"] = body.usernames if body.usernames else ["replaceme"]
    parsed["targeted_creator"]["use_following"] = body.use_following
    parsed["targeted_creator"]["use_following_with_pagination"] = body.use_following_with_pagination
    with tempfile.NamedTemporaryFile("w", delete=False, dir=str(config_path.parent), suffix=".tmp") as f:
        yaml.dump(parsed, f)
        tmp_path = f.name
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, config_path)
    restarted = False
    if body.restart_scraper:
        r = subprocess.run(["systemctl", "restart", cfg["systemd_unit"]], capture_output=True)
        restarted = r.returncode == 0
    return {"ok": True, "restarted": restarted}


@app.post("/api/fansly/control/{action}")
def fansly_control(action: str):
    if action not in ("start", "stop", "restart"):
        raise HTTPException(400, "Invalid action")
    r = subprocess.run(
        ["systemctl", action, SERVICES["fansly"]["systemd_unit"]],
        capture_output=True, text=True,
    )
    return {"ok": r.returncode == 0, "stderr": r.stderr[:500]}


# Coomer/Kemono queue + discover + run ──────────────────────────

class QueueUpdate(BaseModel):
    users: list[dict] = []
    default_service: str | None = None
    extra_args: str = ""


@app.get("/api/{service}/queue")
def get_queue(service: str):
    cfg = get_service(service)
    if cfg["kind"] != "oneshot":
        raise HTTPException(400, "Queue only applies to oneshot services")
    q = load_queue(service)
    return {**q, "run": RUNNERS[service].state_snapshot}


@app.put("/api/{service}/queue")
def put_queue(service: str, body: QueueUpdate):
    cfg = get_service(service)
    if cfg["kind"] != "oneshot":
        raise HTTPException(400, "Queue only applies to oneshot services")
    default_service = body.default_service or cfg.get("default_service", "onlyfans")
    clean_users = []
    for u in body.users:
        if not isinstance(u, dict):
            continue
        inp = str(u.get("input", "")).strip()
        if not inp:
            continue
        usvc = str(u.get("service") or default_service).strip().lower()
        clean_links = []
        for l in u.get("links", []):
            if not isinstance(l, dict):
                continue
            lsvc = str(l.get("service", "")).strip().lower()
            lname = str(l.get("name", "")).strip()
            lid = str(l.get("id", "")).strip()
            if not lsvc or not lname or not lid:
                continue
            clean_links.append({
                "service": lsvc,
                "id": lid,
                "name": lname,
                "enabled": bool(l.get("enabled", False)),
            })
        clean_users.append({"input": inp, "service": usvc, "links": clean_links})
    save_queue(service, {
        "users": clean_users,
        "default_service": default_service,
        "extra_args": body.extra_args.strip(),
    })
    return {
        "ok": True,
        "user_count": len(clean_users),
        "enabled_links": sum(1 for u in clean_users for l in u["links"] if l["enabled"]),
    }


class DiscoverInput(BaseModel):
    usernames: list[str]
    default_service: str = "onlyfans"


@app.post("/api/{service}/discover")
def discover(service: str, body: DiscoverInput):
    cfg = get_service(service)
    if cfg["kind"] != "oneshot":
        raise HTTPException(400, "Discover only applies to oneshot services")
    if cfg.get("no_discovery"):
        raise HTTPException(400, f"{cfg['label']} does not support link discovery — paste full profile URLs directly into the queue.")
    results = []
    for raw in body.usernames:
        name, user_service = _parse_input_token(raw, body.default_service)
        if not name:
            continue
        entry: dict[str, Any] = {"input": name, "service": user_service}
        try:
            profile = _fetch_profile(service, user_service, name)
        except HTTPException as he:
            entry["error"] = he.detail
            entry["links"] = []
            results.append(entry)
            continue
        except Exception as e:
            entry["error"] = str(e)[:200]
            entry["links"] = []
            results.append(entry)
            continue

        if profile is None:
            # The queried service+username doesn't exist on the site.
            # Fall back to a case-insensitive search across ALL creators.
            matches = _search_creators(service, name)
            if not matches:
                entry["error"] = (
                    f"No profile at /{user_service}/user/{name} on "
                    f"{cfg['domain']}, and no search matches found."
                )
                entry["links"] = []
                results.append(entry)
                continue

            # Auto-resolve when there is a single unambiguous exact-name match
            # (case-insensitive). Otherwise return the suggestions list and let
            # the user pick one in the UI.
            name_lower = name.lower()
            exact = [
                c for c in matches
                if (c.get("name") or "").lower() == name_lower
                or (c.get("id") or "").lower() == name_lower
            ]
            if len(exact) == 1:
                chosen = exact[0]
                new_service = chosen.get("service") or user_service
                new_id = str(chosen.get("id") or name)
                profile = _fetch_profile(service, new_service, new_id)
                if profile is None:
                    # Race: cache says it exists, /profile disagrees. Surface suggestions.
                    entry["error"] = "Auto-match found but profile lookup re-failed."
                    entry["suggestions"] = [
                        {"service": c.get("service"), "id": str(c.get("id")), "name": c.get("name", str(c.get("id")))}
                        for c in matches
                    ]
                    entry["links"] = []
                    results.append(entry)
                    continue
                # Promote the resolved user, capture the rename
                entry["resolved_from"] = {"input": name, "service": user_service}
                entry["input"] = chosen.get("name") or new_id
                entry["service"] = new_service
                user_service = new_service
                name = new_id
                # fall through to the links-fetch logic below using profile
            else:
                # Multiple candidates — let the UI offer them as clickable picks
                entry["error"] = (
                    f"No exact profile at /{user_service}/user/{name}. "
                    f"Found {len(matches)} similar — pick one:"
                )
                entry["suggestions"] = [
                    {"service": c.get("service"), "id": str(c.get("id")), "name": c.get("name", str(c.get("id")))}
                    for c in matches
                ]
                entry["links"] = []
                results.append(entry)
                continue

        # Profile exists — fetch linked alternates (may be empty).
        try:
            link_list = _fetch_links(service, user_service, name)
        except Exception:
            link_list = []

        # Always include the queried user themselves as the first link.
        canonical_id = str(profile.get("id") or name)
        canonical_name = profile.get("name") or name
        all_links = [{
            "service": user_service,
            "id": canonical_id,
            "name": canonical_name,
            "updated": profile.get("updated"),
            "is_self": True,
        }]
        seen = {(user_service, canonical_id)}
        for l in link_list:
            if not (l.get("service") and l.get("id") is not None):
                continue
            lid = str(l.get("id"))
            key = (l.get("service"), lid)
            if key in seen:
                continue
            seen.add(key)
            all_links.append({
                "service": l.get("service"),
                "id": lid,
                "name": l.get("name", lid),
                "updated": l.get("updated"),
            })
        entry["links"] = all_links
        results.append(entry)
    return {"results": results}


def _build_coomerfans_commands(svc: str) -> list[tuple[list[str], str]]:
    """Coomerfans has a flat URL list — we run ONE subprocess that processes
    all URLs via --input-file."""
    cfg = SERVICES[svc]
    q = load_queue(svc)
    # The coomerfans queue stores its URLs in the same "users" list but with
    # links==[]; we extract whatever's in q["users"][*]["input"] as URL tokens.
    # We also fall back to a flat q["urls"] field for back-compat.
    tokens = []
    for u in q.get("users", []):
        inp = (u.get("input") or "").strip()
        if inp:
            tokens.append(inp)
    for u in q.get("urls", []) or []:
        u = (u or "").strip()
        if u:
            tokens.append(u)
    tokens = list(dict.fromkeys(tokens))  # dedupe preserving order
    if not tokens:
        return []
    # Materialize the URL list to a sidecar file the scraper will read
    queue_text = cfg["queue_file"].with_suffix(".urls.txt")
    queue_text.write_text("\n".join(tokens) + "\n")
    cfg["root"].mkdir(parents=True, exist_ok=True)
    cmd = [
        str(cfg["cli_python"]),
        str(cfg["cli_script"]),
        "--input-file", str(queue_text),
        "-d", str(cfg["root"]),
        "--default-service", q.get("default_service") or cfg.get("default_service", "onlyfans"),
        "-n",  # only-new
    ]
    extra = (q.get("extra_args") or "").strip()
    if extra:
        cmd += extra.split()
    return [(cmd, f"coomerfans batch ({len(tokens)} target{'s' if len(tokens) != 1 else ''})")]


@app.post("/api/{service}/run")
async def run_now(service: str):
    cfg = get_service(service)
    if cfg["kind"] != "oneshot":
        raise HTTPException(400, "Run only applies to oneshot services")
    if cfg.get("no_discovery"):
        items = _build_coomerfans_commands(service)
        cwd = "/opt/coomerfans-scraper"
    else:
        items = _build_per_link_commands(service)
        cwd = str(COOMER_CLI)
    if not items:
        raise HTTPException(400, "Queue empty")
    await RUNNERS[service].start_batch(items, cwd=cwd)
    return {"ok": True, "batch_size": len(items)}


@app.post("/api/{service}/cancel")
async def cancel_run(service: str):
    cfg = get_service(service)
    if cfg["kind"] != "oneshot":
        raise HTTPException(400, "Cancel only applies to oneshot services")
    ok = await RUNNERS[service].cancel()
    return {"ok": ok, "was_running": ok}


# Auto-run timers ────────────────────────────────────────────────

AUTORUN_SCHEDULES = {
    "1h":  "*-*-* *:00:00",
    "3h":  "*-*-* 00,03,06,09,12,15,18,21:00:00",
    "6h":  "*-*-* 00,06,12,18:00:00",
    "12h": "*-*-* 00,12:00:00",
    "24h": "*-*-* 03:00:00",
}


def _timer_unit_path(svc: str) -> str:
    return f"/etc/systemd/system/{svc}-autorun.timer"


def _read_timer_schedule(svc: str):
    try:
        text = open(_timer_unit_path(svc)).read()
    except OSError:
        return None
    m = re.search(r"^OnCalendar=(.+)$", text, re.M)
    if not m:
        return None
    current = m.group(1).strip()
    for key, expr in AUTORUN_SCHEDULES.items():
        if current == expr:
            return key
    return "custom"


def _write_timer(svc: str, schedule_key: str) -> None:
    expr = AUTORUN_SCHEDULES.get(schedule_key)
    if not expr:
        raise HTTPException(400, f"Unknown schedule: {schedule_key}")
    content = (
        "[Unit]\n"
        f"Description=Trigger {svc} scraper auto-run on a schedule\n"
        "\n"
        "[Timer]\n"
        f"OnCalendar={expr}\n"
        "RandomizedDelaySec=600\n"
        "Persistent=true\n"
        f"Unit={svc}-autorun.service\n"
        "\n"
        "[Install]\n"
        "WantedBy=timers.target\n"
    )
    path = _timer_unit_path(svc)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.replace(tmp, path)
    subprocess.run(["systemctl", "daemon-reload"], check=False)


def _timer_state(svc: str):
    timer = f"{svc}-autorun.timer"
    enabled = subprocess.run(["systemctl", "is-enabled", timer],
                              capture_output=True, text=True).stdout.strip()
    active = subprocess.run(["systemctl", "is-active", timer],
                             capture_output=True, text=True).stdout.strip()
    is_on = enabled in ("enabled", "static") and active == "active"
    show = subprocess.run(
        ["systemctl", "show", timer, "-p", "NextElapseUSecRealtime,LastTriggerUSec", "--value"],
        capture_output=True, text=True,
    )
    next_fire = last_fire = None
    lines = show.stdout.strip().split("\n")
    if len(lines) >= 1 and lines[0]:
        try:
            next_fire = int(lines[0]) / 1_000_000
        except (ValueError, TypeError):
            pass
    if len(lines) >= 2 and lines[1]:
        try:
            v = int(lines[1])
            if v > 0:
                last_fire = v / 1_000_000
        except (ValueError, TypeError):
            pass
    return {
        "enabled": is_on,
        "schedule": _read_timer_schedule(svc),
        "next_fire_time": next_fire,
        "last_fire_time": last_fire,
    }


@app.get("/api/{service}/autorun")
def get_autorun(service: str):
    cfg = get_service(service)
    if cfg["kind"] != "oneshot":
        raise HTTPException(400, "Auto-run only applies to oneshot services")
    state = _timer_state(service)
    state["schedules_available"] = sorted(AUTORUN_SCHEDULES.keys(), key=lambda x: int(x.rstrip("h")))
    return state


class AutorunUpdate(BaseModel):
    enabled: bool
    schedule: str = "6h"


@app.put("/api/{service}/autorun")
def put_autorun(service: str, body: AutorunUpdate):
    cfg = get_service(service)
    if cfg["kind"] != "oneshot":
        raise HTTPException(400, "Auto-run only applies to oneshot services")
    _write_timer(service, body.schedule)
    timer = f"{service}-autorun.timer"
    cmd = ["systemctl", "enable" if body.enabled else "disable", "--now", timer]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return {
        "ok": r.returncode == 0,
        "stderr": r.stderr[:300] if r.stderr else "",
        "state": _timer_state(service),
    }


# Health check (AI-Lab addon manifest healthPath) ────────────────

@app.get("/health")
def health():
    return {"ok": True, "addon": "fansly", "services": list(SERVICES)}


# Static frontend ───────────────────────────────────────────────

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
