#!/usr/bin/env python3
"""Image Request page: pick a model, LoRAs, a pose and reference images on a phone, then send it
all to an image agent (Cinder) as ONE Matrix message from the user's own account.

Why one message: Hermes starts a turn on the first event it sees, so posting each reference image
as its own m.image would make the agent answer before the request arrived. Instead the single
m.text carries every file's path on this server (where the agent's ComfyUI workflows need them
anyway), and its formatted body shows the images inline for the human.

Data it reads (never writes): /imagegen checkpoints, diffusion-models, loras (+ Civitai sidecars),
the pose library via poses-site (127.0.0.1:17895).
Data it writes: reference uploads under REFS_DIR, and STATE_DIR (sqlite: refs, templates,
history; matrix-sessions.json, 0600).

Access is two layers:
  1. the GATE: a valid Cloudflare Access JWT (the public hostname), or a LAN/tailnet client on the
     AI-Lab trusted-source list;
  2. the PERSON: a PIN typed on the page picks who is using it (several people share devices), and a
     session cookie remembers it. The person's Matrix account is used, and a person marked
     "restricted" in config.json only sees the families / finetunes / LoRAs an admin ticked for them
     (table `visibility`).
"""
import asyncio
import base64
import hashlib
import hmac
import html
import io
import ipaddress
import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

import httpx
import jwt
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image, ImageOps

try:  # iPhone photos arrive as HEIC; Pillow can't open them without this.
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

HERE = Path(__file__).resolve().parent
IMAGEGEN = Path(os.environ.get("IMAGEGEN_ROOT", "/imagegen")).resolve()
REFS_DIR = Path(os.environ.get("REFS_DIR", "/imagegen/request_refs")).resolve()
STATE_DIR = Path(os.environ.get("STATE_DIR", "/var/lib/imagine"))
CACHE_DIR = Path(os.environ.get("CACHE_DIR", "/var/cache/imagine"))
POSES_URL = os.environ.get("POSES_URL", "http://127.0.0.1:17895")
AILAB = os.environ.get("AILAB_URL", "http://127.0.0.1:17890")
VLM_MODEL = os.environ.get("IMAGINE_VLM_MODEL", "Qwen3.8-27B-INT8-MM-8_Slot-Think_Preserve-256k")
TRUSTED_FILE = os.environ.get("TRUSTED_SOURCES", "/opt/ai-lab/.gybackend-data/trusted-sources.json")
NPM_PEERS = {"10.0.0.106"}          # Nginx Proxy Manager: the only peer whose X-Real-IP we believe
BUILTIN_TRUSTED = ["127.0.0.0/8", "10.0.0.219/32", "10.0.0.161/32", "10.0.0.67/32"]
IMG_EXT = (".jpeg", ".jpg", ".png", ".webp")
PREVIEW_W = {"grid": 420, "full": 1600}
MAX_UPLOAD = 40 * 1024 * 1024

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("imagine")
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


# ── config ───────────────────────────────────────────────────────────────────────────────────
def load_json(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


CONFIG = load_json(HERE / "config.json", {})
MODELS = load_json(HERE / "models.json", [])


def person_by_id(pid):
    return next((p for p in CONFIG.get("people", []) if p["id"] == pid), None)


# ── auth ─────────────────────────────────────────────────────────────────────────────────────
_jwks = {"at": 0, "client": None}


def cf_email(req: Request):
    tok = req.headers.get("cf-access-jwt-assertion") or req.cookies.get("CF_Authorization")
    cf = CONFIG.get("cloudflare_access") or {}
    if not tok or not cf.get("team_domain") or not cf.get("aud"):
        return None
    try:
        if not _jwks["client"] or time.time() - _jwks["at"] > 3600:
            _jwks["client"] = jwt.PyJWKClient(f"https://{cf['team_domain']}/cdn-cgi/access/certs")
            _jwks["at"] = time.time()
        key = _jwks["client"].get_signing_key_from_jwt(tok).key
        claims = jwt.decode(tok, key, algorithms=["RS256"], audience=cf["aud"])
        return claims.get("email")
    except Exception as e:  # noqa: BLE001
        log.warning("CF Access JWT rejected: %s", e)
        return None


def client_ip(req: Request):
    """The address of the device, as far as we can PROVE it.

    Not X-Real-IP / X-Forwarded-For: NPM's nginx.conf trusts X-Real-IP from all of 10.0.0.0/8,
    so any LAN client could claim to be the trusted phone. NPM's proxy host for this page sets
    X-Imagine-Peer from $realip_remote_addr (the real TCP peer), overwriting anything the client
    sent, and we believe that header only when the connection itself comes from NPM.
    """
    peer = req.client.host if req.client else ""
    if peer in NPM_PEERS:
        return req.headers.get("x-imagine-peer") or ""
    return peer


def trusted_ip(ip):
    nets = list(BUILTIN_TRUSTED)
    nets += [s.get("cidr") for s in load_json(TRUSTED_FILE, {}).get("sources", []) if s.get("cidr")]
    try:
        a = ipaddress.ip_address(ip)
        return any(a in ipaddress.ip_network(n, strict=False) for n in nets)
    except ValueError:
        return False


def gate(req: Request):
    """Layer 1: may this device reach the page at all? (Cloudflare Access only lets the people on
    the app's policy through, so any valid JWT passes.)"""
    if cf_email(req):
        return
    ip = client_ip(req)
    if trusted_ip(ip):
        return
    log.warning("refused %s %s (ip %s, no Access identity)", req.method, req.url.path, ip)
    raise HTTPException(403, "Open this page through its Cloudflare address, or from a trusted device")


SESSION_COOKIE = "imagine_session"
SESSION_TTL = 365 * 86400


def tok_hash(tok):
    return hashlib.sha256(tok.encode()).hexdigest()


def who(req: Request):
    """Layer 2: the person whose PIN opened this browser's session."""
    gate(req)
    tok = req.cookies.get(SESSION_COOKIE)
    if tok:
        with db() as c:
            r = c.execute("SELECT person, created FROM sessions WHERE token=?", (tok_hash(tok),)).fetchone()
        if r and time.time() - r["created"] < SESSION_TTL:
            p = person_by_id(r["person"])
            if p:
                return p
    raise HTTPException(401, "PIN required")


def admin(req: Request):
    p = who(req)
    if not p.get("admin"):
        raise HTTPException(403, "admin only")
    return p


# ── state ────────────────────────────────────────────────────────────────────────────────────
STATE_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
_db_lock = threading.Lock()


def db():
    c = sqlite3.connect(STATE_DIR / "imagine.db", timeout=30)
    c.row_factory = sqlite3.Row
    return c


with db() as _c:
    _c.executescript("""
    CREATE TABLE IF NOT EXISTS refs(id TEXT PRIMARY KEY, person TEXT, path TEXT, name TEXT, w INT, h INT,
        created REAL, hidden INT DEFAULT 0);
    CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY, person TEXT, name TEXT, data TEXT, updated REAL);
    CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, person TEXT, agent TEXT, event_id TEXT,
        data TEXT, body TEXT, created REAL);
    -- Poses uploaded from this page, while AI-Lab's pipeline turns them into library poses.
    -- state: queued (waiting for a GPU) | mannequin | skeleton | describing | ready | failed
    CREATE TABLE IF NOT EXISTS pose_uploads(pose_id TEXT PRIMARY KEY, person TEXT, src TEXT, created REAL,
        state TEXT, detail TEXT, mq_job TEXT, gpu TEXT, updated REAL, ai_prompt TEXT);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, person TEXT, created REAL, ip TEXT);
    -- What a restricted person may see. kind: base (key = family id), ft / lora (key = family/item id)
    CREATE TABLE IF NOT EXISTS visibility(person TEXT, kind TEXT, key TEXT, PRIMARY KEY(person, kind, key));
    """)

SESS_FILE = STATE_DIR / "matrix-sessions.json"
PIN_FILE = STATE_DIR / "pins.json"   # {person id: "pbkdf2$<salt hex>$<hash hex>"}, 0600


def pin_hash(pin, salt=None):
    salt = salt or os.urandom(16)
    return "pbkdf2$" + salt.hex() + "$" + hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 200_000).hex()


def pin_ok(pin, stored):
    try:
        _, salt, _h = stored.split("$")
        return hmac.compare_digest(pin_hash(pin, bytes.fromhex(salt)), stored)
    except ValueError:
        return False


def save_private(path, obj):
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def sessions():
    return load_json(SESS_FILE, {})


def save_sessions(s):
    save_private(SESS_FILE, s)


# ── images ───────────────────────────────────────────────────────────────────────────────────
def safe_path(rel):
    full = (IMAGEGEN / rel).resolve()
    if not str(full).startswith(str(IMAGEGEN) + os.sep) or full.suffix.lower() not in IMG_EXT or not full.is_file():
        raise HTTPException(404, "not found")
    return full


def preview_bytes(path: Path, size: str):
    st = path.stat()
    key = hashlib.sha1(str(path).encode()).hexdigest()
    out = CACHE_DIR / size / f"{key}.{st.st_mtime_ns}.webp"
    if out.is_file():
        return out.read_bytes()
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA")
    w = PREVIEW_W[size]
    if im.width > w:
        im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=84)
    data = buf.getvalue()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, out)
    return data


def img_url(path: Path):
    return "/img/" + str(path.relative_to(IMAGEGEN))


def previews_for(weights: Path):
    """name.jpeg, name_1.jpeg … next to a .safetensors, in Civitai order."""
    base = weights.with_suffix("")
    found = []
    for ext in IMG_EXT:
        p = Path(str(base) + ext)
        if p.is_file():
            found.append((0, p))
    for p in weights.parent.glob(base.name + "_*"):
        m = re.fullmatch(re.escape(base.name) + r"_(\d+)", p.stem)
        if m and p.suffix.lower() in IMG_EXT:
            found.append((int(m.group(1)), p))
    return [p for _, p in sorted(found)]


def html_to_text(s):
    s = re.sub(r"(?is)<(script|style).*?</\1>", "", s or "")
    s = re.sub(r"(?i)<br\s*/?>|</p>|</h\d>|</li>", "\n", s)
    s = re.sub(r"(?i)<li[^>]*>", "• ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


# ── models ───────────────────────────────────────────────────────────────────────────────────
_scan_cache = {}


def cached(key, dirs, fn):
    sig = tuple((str(d), d.stat().st_mtime_ns) for d in dirs if d.is_dir())
    hit = _scan_cache.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    val = fn()
    _scan_cache[key] = (sig, val)
    return val


def model_by_id(mid):
    m = next((x for x in MODELS if x["id"] == mid), None)
    if not m:
        raise HTTPException(404, "unknown model")
    return m


WEIGHT_EXT = (".safetensors", ".gguf")
SEP_AFTER_BASE = "-_.(（ "


def set_images(base: Path):
    """<base>.<ext> and <base>_<N>.<ext> next to a Civitai sidecar, in index order."""
    d, stem = base.parent, base.name
    pat = re.compile(re.escape(stem) + r"(?:_(\d+))?(\.(?:jpeg|jpg|png|webp))$", re.I)
    found = []
    for p in d.iterdir():
        mm = pat.fullmatch(p.name)
        if mm:
            found.append((int(mm.group(1) or 0), p))
    return [p for _, p in sorted(found)]


def _squash(s):
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def custom_label(stem, ver):
    """The name Travis gave a download, or None when the file still carries Civitai's own name.
    Renamed = the stem differs from every original filename in the .civit.info (ignoring case,
    spaces and punctuation, which the downloader rewrites). Shown with underscores as spaces and
    the trailing -<versionId> the downloader appends dropped; repo names are often unreadable."""
    orig = {_squash(Path(f["name"]).stem) for f in (ver.get("files") or []) if f.get("name")}
    if not orig or _squash(stem) in orig:
        return None
    return re.sub(r"-\d{5,}$", "", stem).replace("_", " ").strip() or None


def finetunes(m):
    """One entry per downloaded finetune of a family. A Civitai download leaves <base>.civit.info
    beside its weights; every weights file whose stem is <base> or <base><sep>… (precision variants:
    -bf16, -fp8, -INT8 …) belongs to it. Weights with no sidecar become their own entry."""
    dirs = [IMAGEGEN / d for d in m.get("dirs", [])]

    def scan():
        out = []
        for root in dirs:
            if not root.is_dir():
                continue
            for dirpath, dirnames, files in os.walk(root):
                dirnames[:] = [x for x in dirnames if not x.startswith(".")]
                dp = Path(dirpath)
                bases = sorted({f[: -len(".civit.info")] for f in files if f.endswith(".civit.info")}, key=len, reverse=True)
                groups = {}
                for w in sorted(f for f in files if f.endswith(WEIGHT_EXT)):
                    stem = w.rsplit(".", 1)[0]
                    owner = next((b for b in bases if stem == b or (stem.startswith(b) and stem[len(b)] in SEP_AFTER_BASE)), None)
                    groups.setdefault(owner or stem, []).append(dp / w)
                for base, ws in groups.items():
                    bp = dp / base
                    full = load_json(str(bp) + ".civit.full.info", {}) or {}
                    ver = load_json(str(bp) + ".civit.info", {}) or {}
                    side = load_json(str(bp) + ".metadata.json", {}) or load_json(str(ws[0].with_suffix("")) + ".metadata.json", {}) or {}
                    civ = side.get("civitai") or {}
                    imgs = set_images(bp)
                    if not imgs:
                        for w in ws:
                            imgs += previews_for(w)
                    model_id = full.get("id") or civ.get("modelId")
                    version_id = ver.get("id") or civ.get("id")
                    rel_dir = str(dp.relative_to(root))
                    repo = full.get("name") or (civ.get("model") or {}).get("name") or side.get("model_name")
                    out.append({
                        "id": hashlib.sha1(str(bp).encode()).hexdigest()[:12],
                        "name": custom_label(base, ver) or repo or base.replace("_", " "),
                        "repo_name": repo or "",
                        "version": ver.get("name") or civ.get("name") or "",
                        "folder": "" if rel_dir == "." else rel_dir,
                        "images": imgs,
                        "files": [{"path": str(w), "size": w.stat().st_size} for w in ws],
                        "description": html_to_text(full.get("description") or side.get("modelDescription") or ""),
                        "version_description": html_to_text(ver.get("description") or civ.get("description") or ""),
                        "base_model": ver.get("baseModel") or side.get("base_model") or "",
                        "creator": (full.get("creator") or {}).get("username") or "",
                        "civitai_url": (f"https://civitai.com/models/{model_id}" + (f"?modelVersionId={version_id}" if version_id else "")) if model_id else None,
                        "nsfw": bool(full.get("nsfw")),
                    })
        out.sort(key=lambda x: (x["name"].lower(), x["version"].lower()))
        return out
    # Walk-based, so key the cache on every directory's mtime under the family roots.
    all_dirs = []
    for r in dirs:
        if r.is_dir():
            all_dirs += [Path(dp) for dp, dn, _ in os.walk(r) if "/." not in dp]
    return cached("ft:" + m["id"], all_dirs, scan)


def ft_public(f, full=False):
    d = {k: f[k] for k in ("id", "name", "repo_name", "version", "folder", "base_model", "nsfw")}
    d.update(cover=img_url(f["images"][0]) if f["images"] else None, image_count=len(f["images"]), file_count=len(f["files"]))
    if full:
        d.update(images=[img_url(p) for p in f["images"]], files=f["files"], description=f["description"],
                 version_description=f["version_description"], creator=f["creator"], civitai_url=f["civitai_url"])
    return d


def model_images(m):
    dirs = [IMAGEGEN / d for d in m.get("dirs", [])]

    def scan():
        weights = []
        for d in dirs:
            if d.is_dir():
                weights += sorted(p for p in d.iterdir() if p.suffix in (".safetensors", ".gguf"))
        cover_first = m.get("cover")
        out = []
        for w in weights:
            out += previews_for(w)
        # Civitai previews are often named after the REPO (Z-Image-Turbo.jpeg) while the weights
        # carry a precision suffix (Z-Image-Turbo_BF16.safetensors), so they never match a file.
        # Every image in a model folder is an example of that family; append the unmatched ones.
        seen = set(out)
        for d in dirs:
            if d.is_dir():
                extra = [p for p in d.iterdir() if p.suffix.lower() in IMG_EXT and p not in seen]
                out += sorted(extra, key=lambda p: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)])
        if cover_first:
            c = IMAGEGEN / cover_first
            if c.is_file():
                out = [c] + [p for p in out if p != c]
        files = [str(w.relative_to(IMAGEGEN)) for w in weights]
        return {"images": out, "files": files}
    return cached("model:" + m["id"], dirs, scan)


# ── what a restricted person may see ────────────────────────────────────────────────────────
def allowed(person):
    """None = sees everything; else the set of (kind, key) an admin ticked for them."""
    if not person.get("restricted"):
        return None
    with db() as c:
        return {(r["kind"], r["key"]) for r in c.execute("SELECT kind, key FROM visibility WHERE person=?", (person["id"],))}


def can_see(al, kind, mid, item=None):
    return al is None or (kind, mid if item is None else f"{mid}/{item}") in al


def family_visible(al, mid):
    """A family shows when anything in it (its base card, a finetune, a LoRA) was ticked."""
    return al is None or any(k == mid or k.startswith(mid + "/") for _, k in al)


def visible_model(person, mid):
    m = model_by_id(mid)
    if not family_visible(allowed(person), mid):
        raise HTTPException(404, "unknown model")
    return m


@app.get("/api/models")
def api_models(req: Request):
    person = who(req)
    al = allowed(person)
    out = []
    for m in MODELS:
        if not family_visible(al, m["id"]):
            continue
        s = model_images(m)
        fts = [f for f in finetunes(m) if can_see(al, "ft", m["id"], f["id"])]
        out.append({k: m.get(k) for k in ("id", "name", "family", "edit", "refs", "max_refs", "description", "best_for", "notes")}
                   | {"cover": img_url(s["images"][0]) if s["images"] else None,
                      "image_count": len(s["images"]), "file_count": len(s["files"]), "finetune_count": len(fts),
                      "base_visible": can_see(al, "base", m["id"])})
    return out


@app.get("/api/models/{mid}")
def api_model(mid: str, req: Request):
    m = visible_model(who(req), mid)
    s = model_images(m)
    return {"images": [img_url(p) for p in s["images"][:400]], "files": s["files"]}


@app.get("/api/models/{mid}/finetunes")
def api_finetunes(mid: str, req: Request):
    person = who(req)
    al = allowed(person)
    return [ft_public(f) for f in finetunes(visible_model(person, mid)) if can_see(al, "ft", mid, f["id"])]


@app.get("/api/models/{mid}/finetunes/{fid}")
def api_finetune(mid: str, fid: str, req: Request):
    person = who(req)
    f = next((f for f in finetunes(visible_model(person, mid)) if f["id"] == fid), None)
    if not f or not can_see(allowed(person), "ft", mid, fid):
        raise HTTPException(404, "unknown finetune")
    return ft_public(f, full=True)


# ── LoRAs ────────────────────────────────────────────────────────────────────────────────────
LAYERS = ["character", "style", "clothing", "concept", "poses", "pose", "background", "objects",
          "vehicle", "buildings", "animal", "action", "tool", "assets", "celebrity", "base model"]
LAYER_LABEL = {"poses": "Pose", "pose": "Pose", "base model": "Base"}


def lora_meta(w: Path):
    base = w.with_suffix("")
    full = load_json(str(base) + ".civit.full.info", {}) or {}
    ver = load_json(str(base) + ".civit.info", {}) or {}
    side = load_json(str(base) + ".metadata.json", {}) or load_json(str(base) + ".json", {}) or {}
    civ = side.get("civitai") or {}
    tags = [str(t).lower() for t in (full.get("tags") or side.get("tags") or [])]
    layer = next((t for t in LAYERS if t in tags), None)
    if not layer:
        pre = w.stem.split("-", 1)[0].lower()
        layer = next((t for t in LAYERS if t == pre or t.rstrip("s") == pre.rstrip("s")), None)
    model_id = full.get("id") or civ.get("modelId")
    version_id = ver.get("id") or civ.get("id")
    words = ver.get("trainedWords") or civ.get("trainedWords") or side.get("trainedWords") or []
    repo = full.get("name") or (civ.get("model") or {}).get("name") or side.get("model_name")
    return {
        "name": custom_label(w.stem, ver) or repo or w.stem,
        "repo_name": repo or "",
        "version": ver.get("name") or civ.get("name") or "",
        "layer": (LAYER_LABEL.get(layer) or layer.title()) if layer else "Other",
        "tags": tags[:20],
        "trained_words": [str(x) for x in words][:30],
        "base_model": ver.get("baseModel") or side.get("base_model") or "",
        "creator": (full.get("creator") or {}).get("username") or "",
        "description": html_to_text(full.get("description") or side.get("modelDescription") or ""),
        "version_description": html_to_text(ver.get("description") or civ.get("description") or ""),
        "civitai_url": (f"https://civitai.com/models/{model_id}" + (f"?modelVersionId={version_id}" if version_id else "")) if model_id else None,
        "nsfw": bool(full.get("nsfw")),
    }


def lora_index(m):
    dirs = [IMAGEGEN / "loras" / d for d in m.get("lora_dirs", [])]

    def scan():
        out = []
        for d in dirs:
            if not d.is_dir():
                continue
            for w in sorted(d.glob("*.safetensors")):
                try:
                    meta = lora_meta(w)
                except Exception as e:  # noqa: BLE001
                    log.warning("lora meta %s: %s", w, e)
                    meta = {"name": w.stem, "layer": "Other", "trained_words": []}
                prev = previews_for(w)
                out.append({"id": hashlib.sha1(str(w).encode()).hexdigest()[:16],
                            "path": str(w.relative_to(IMAGEGEN)), "file": w.name,
                            "cover": img_url(prev[0]) if prev else None,
                            "images": [img_url(p) for p in prev], **meta})
        out.sort(key=lambda x: x["name"].lower())
        return out
    return cached("loras:" + m["id"], dirs, scan)


@app.get("/api/loras")
def api_loras(model: str, req: Request):
    person = who(req)
    al = allowed(person)
    keep = ("id", "path", "file", "cover", "name", "repo_name", "version", "layer", "trained_words", "nsfw")
    return [{k: x.get(k) for k in keep} for x in lora_index(visible_model(person, model)) if can_see(al, "lora", model, x["id"])]


@app.get("/api/loras/{model}/{lid}")
def api_lora(model: str, lid: str, req: Request):
    person = who(req)
    x = next((x for x in lora_index(visible_model(person, model)) if x["id"] == lid), None)
    if not x or not can_see(allowed(person), "lora", model, lid):
        raise HTTPException(404, "unknown LoRA")
    return x


# ── poses (read through poses-site, the library's single reader) ─────────────────────────────
@app.get("/api/poses")
async def api_poses(req: Request):
    who(req)
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{POSES_URL}/api/poses")
    if r.status_code != 200:
        return Response(r.content, r.status_code, media_type="application/json")
    # Uploads still in the pipeline appear in the pose section's upload strip, not the grid.
    with db() as c:
        pending = {row["pose_id"] for row in c.execute("SELECT pose_id FROM pose_uploads WHERE state != 'ready'")}
    return [p for p in r.json() if p.get("id") not in pending and p.get("prompt") != POSE_PLACEHOLDER]


@app.get("/poseimg/{size}/{kind}/{pid}.webp")
async def pose_img(size: str, kind: str, pid: str, req: Request):
    who(req)
    if size not in ("grid", "full") or not re.fullmatch(r"pose_\d{1,5}", pid) or \
            kind not in ("original", "thumb", "mannequin", "overlay", "skeleton"):
        raise HTTPException(404)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{POSES_URL}/img/{size}/{kind}/{pid}.webp")
    return Response(r.content, r.status_code, media_type="image/webp",
                    headers={"Cache-Control": "private, max-age=300"})


POSE_LIB = IMAGEGEN / "pose_library"


def pose_files(pose):
    """Absolute paths the agent can use, mirroring poses-site's files_for()."""
    pid = pose["id"]
    cand = {
        "thumbnail": POSE_LIB / "pose_images" / (pose.get("image") or f"{pid}.webp"),
        "mannequin": POSE_LIB / "mannequin_images" / (pose.get("mannequin") or f"{pid}.png"),
        "skeleton": POSE_LIB / "skeletons" / f"{pid}_skel.png",
        "skeleton overlay": POSE_LIB / "skeletons" / f"{pid}_overlay.png",
        "upscaled": POSE_LIB / "upscaled_images" / f"{pid}.png",
    }
    src = pose.get("source")
    if src:
        s = (IMAGEGEN / src).resolve()
        if str(s).startswith(str(IMAGEGEN) + os.sep) and s.is_file():
            cand = {"original photo": s, **cand}
    return {k: str(v) for k, v in cand.items() if v.is_file()}


def load_pose(n):
    lib = load_json(POSE_LIB / "poses.json", [])
    return next((p for p in lib if p.get("index") == n), None)


# ── pose uploads → AI-Lab pose pipeline ─────────────────────────────────────────────────────
# AI-Lab owns the pose library (poses.json) and its pipeline: /poses/add, then a Qwen-Image 2.1
# "mannequin" worker on a GPU, then OpenPose skeleton detection, which AI-Lab chains on its own
# after a mannequin finishes. This page only adds the pose, picks a GPU, waits, and then has the
# VLM write the pose description, which the person can edit afterwards.
POSE_PLACEHOLDER = "(pose description being written)"
MQ_MIN_FREE_MB = 15000          # same floor as AI-Lab: int8 model + int8 text encoder
MQ_HOST_ORDER = ("ai-epyc", "ai-gpu")
POSE_INSTR = (
    "You write the pose description for a pose-reference library. The images show ONE body pose "
    "(a photo or drawing, and/or a grey mannequin in the same pose). Describe ONLY the camera view and the "
    "body pose, as one comma-separated line in this order: camera view (front / rear / side / three-quarter / "
    "top-down), camera angle (eye-level / high angle / low angle), the overall position (standing, kneeling, "
    "lying on back...), then legs, arms and hands, torso, head and gaze. Never mention clothing, hair, "
    "identity, body type, background, lighting or art style. Examples:\n"
    "front view, eye-level, standing, feet together, arms relaxed at sides\n"
    "Rear view, eye-level, standing, legs straight, one arm raised with hand on head, other arm on hip, hips "
    "tilted to the side, head turned to the right looking over shoulder\n"
    "Side 3/4 view, eye-level, kneeling, torso leaning forward, propped up on elbows, facing away from viewer\n"
    "Output the line only, no preamble, no reasoning.")


def ailab(method, path, **kw):
    with httpx.Client(timeout=kw.pop("timeout", 30)) as c:
        r = c.request(method, f"{AILAB}/api/imagegen{path}", **kw)
    try:
        d = r.json()
    except ValueError:
        d = {}
    if r.status_code >= 400:
        raise RuntimeError(d.get("error") or f"AI-Lab {path}: {r.status_code}")
    return d


def library_pose(pid):
    return next((p for p in load_json(POSE_LIB / "poses.json", []) if p.get("id") == pid), None)


def pick_gpu():
    """(host, gpu index) with room for the mannequin worker, ai-epyc first; None when all are busy.
    ai-gpu V100s run it in fp16 (no bf16): verified to produce real mannequins on 2026-10-16."""
    hosts = ailab("GET", "/poses/mannequin/gpus", timeout=20).get("hosts", {})
    busy = set()
    for j in ailab("GET", "/poses/mannequin/jobs").get("jobs", []):
        if j.get("state") == "running":
            busy |= {(j["host"], g) for g in j.get("gpus", [])}
    for h in MQ_HOST_ORDER:
        info = hosts.get(h) or {}
        if info.get("disabled"):
            continue
        cands = [g for g in info.get("gpus", []) if g["freeMB"] >= MQ_MIN_FREE_MB and not g.get("avoid")
                 and (h, g["index"]) not in busy]
        if cands:
            g = max(cands, key=lambda g: g["freeMB"])
            return h, g["index"]
    return None


def vlm_describe(paths):
    content = [{"type": "text", "text": POSE_INSTR}]
    for p in paths:
        im = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
        im.thumbnail((1024, 1024))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88)
        content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()}})
    budget = 600
    for _ in range(3):
        body = {"model": VLM_MODEL, "messages": [{"role": "user", "content": content}], "max_tokens": budget,
                "temperature": 0.2, "chat_template_kwargs": {"enable_thinking": False}}
        with httpx.Client(timeout=240) as c:
            r = c.post(f"{AILAB}/api/proxy/llm/v1/chat/completions", json=body)
        r.raise_for_status()
        ch = r.json()["choices"][0]
        text = re.sub(r"(?s)<think>.*?</think>", "", ch["message"].get("content") or "").strip().strip('"').strip()
        if text and ch.get("finish_reason") != "length":
            return text.splitlines()[0].strip()
        budget *= 2
    raise RuntimeError("the vision model returned no description")


def pu_set(pid, **kw):
    kw["updated"] = time.time()
    cols = ", ".join(f"{k}=?" for k in kw)
    with _db_lock, db() as c:
        c.execute(f"UPDATE pose_uploads SET {cols} WHERE pose_id=?", (*kw.values(), pid))


def describe_pose(row):
    pose = library_pose(row["pose_id"])
    if not pose:
        raise RuntimeError("the pose was removed from the library")
    imgs = [row["src"]]
    if pose.get("mannequin") and (POSE_LIB / "mannequin_images" / pose["mannequin"]).is_file():
        imgs.append(str(POSE_LIB / "mannequin_images" / pose["mannequin"]))
    text = vlm_describe(imgs)
    cur = library_pose(row["pose_id"]) or {}
    # Only fill the placeholder: a description typed by hand meanwhile wins.
    if cur.get("prompt") in (POSE_PLACEHOLDER, "", None):
        ailab("POST", "/poses/update", json={"id": row["pose_id"], "prompt": text})
    return text


def pose_worker_step():
    with db() as c:
        rows = c.execute("SELECT * FROM pose_uploads WHERE state NOT IN ('ready','failed') ORDER BY created").fetchall()
    for row in rows:
        pid = row["pose_id"]
        try:
            if not library_pose(pid):
                pu_set(pid, state="failed", detail="removed from the library")
                continue
            if row["state"] == "queued":
                g = pick_gpu()
                if not g:
                    pu_set(pid, detail="waiting for a GPU with ~15 GB free")
                    continue
                d = ailab("POST", "/poses/mannequin/start", json={
                    "ids": [pid], "host": g[0], "gpus": [g[1]], "quant": "int8", "te": "int8", "steps": 25, "outpaint": "auto"})
                pu_set(pid, state="mannequin", mq_job=d["job"]["id"], gpu=f"{g[0]} GPU {g[1]}", detail="starting the mannequin worker")
                log.info("pose upload %s: mannequin job %s on %s GPU %s", pid, d["job"]["id"], *g)
            elif row["state"] == "mannequin":
                try:
                    j = ailab("GET", f"/poses/mannequin/status?jobId={row['mq_job']}")["job"]
                except RuntimeError as e:   # AI-Lab restarted: the in-memory job is gone
                    if "unknown job" not in str(e):
                        raise
                    j = {"state": "done" if (library_pose(pid) or {}).get("mannequin") else "lost"}
                if j["state"] == "running":
                    w = (j.get("workers") or [{}])[0]
                    pu_set(pid, detail=w.get("state") or "converting")
                elif j["state"] == "done" and (j.get("results", {}).get(pid, {}).get("status", "ok") == "ok"):
                    pu_set(pid, state="skeleton", detail="detecting the OpenPose skeleton")
                elif j["state"] == "lost":
                    pu_set(pid, state="queued", mq_job=None, detail="AI-Lab restarted; queued again")
                else:
                    err = (j.get("results", {}).get(pid) or {}).get("error") or j.get("error") or j["state"]
                    pu_set(pid, state="failed", detail=f"mannequin: {err}"[:400])
            elif row["state"] == "skeleton":
                p = library_pose(pid) or {}
                if p.get("skeleton_at") or time.time() - (row["updated"] or 0) > 300:
                    pu_set(pid, state="describing", detail="writing the pose description")
            elif row["state"] == "describing":
                text = describe_pose(row)
                pu_set(pid, state="ready", detail="", ai_prompt=text)
                log.info("pose upload %s ready: %s", pid, text)
        except Exception as e:  # noqa: BLE001
            log.warning("pose upload %s (%s): %s", pid, row["state"], e)
            pu_set(pid, detail=f"retrying: {e}"[:400])


def pose_worker():
    while True:
        try:
            pose_worker_step()
        except Exception as e:  # noqa: BLE001
            log.exception("pose worker: %s", e)
        time.sleep(8)


threading.Thread(target=pose_worker, daemon=True, name="pose-worker").start()


def pu_row(r):
    p = library_pose(r["pose_id"]) or {}
    return {"pose_id": r["pose_id"], "n": p.get("index"), "state": r["state"], "detail": r["detail"] or "",
            "gpu": r["gpu"], "created": r["created"], "prompt": p.get("prompt") if p.get("prompt") != POSE_PLACEHOLDER else "",
            "src_url": img_url(Path(r["src"])), "person": r["person"]}


@app.post("/api/poses/upload")
async def upload_pose(req: Request, files: list[UploadFile] = File(...)):
    person = who(req)
    out = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"{f.filename} is over {MAX_UPLOAD // 2**20} MB")
        try:
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        except Exception:
            raise HTTPException(400, f"{f.filename} is not an image")
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGB")
        d = REFS_DIR / person["id"] / "poses"
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"{uuid.uuid4().hex[:12]}.png"    # PNG: rotation baked in, HEIC readable by the workers
        im.save(path, "PNG")
        try:
            os.chmod(path, 0o664)
        except OSError:
            pass
        try:
            r = await asyncio.to_thread(ailab, "POST", "/poses/add", json={
                "prompt": POSE_PLACEHOLDER, "source_path": str(path.relative_to(IMAGEGEN))})
        except RuntimeError as e:
            raise HTTPException(502, f"pose library: {e}")
        pid = r["pose"]["id"]
        with _db_lock, db() as c:
            # AI-Lab gives a removed pose's number to the next new one, so a row for that id may
            # already exist here (state 'failed', detail 'removed'); the new pose replaces it.
            c.execute("INSERT OR REPLACE INTO pose_uploads(pose_id,person,src,created,state,detail,updated) VALUES(?,?,?,?,?,?,?)",
                      (pid, person["id"], str(path), time.time(), "queued", "waiting for a GPU", time.time()))
        log.info("pose upload %s by %s -> %s (#%s)", f.filename, person["id"], path, r["pose"].get("index"))
        out.append(pid)
    with db() as c:
        return [pu_row(r) for r in c.execute(f"SELECT * FROM pose_uploads WHERE pose_id IN ({','.join('?' * len(out))})", out)]


@app.get("/api/poses/uploads")
def list_pose_uploads(req: Request):
    """This person's uploads still in the pipeline, plus ones finished in the last day."""
    person = who(req)
    with db() as c:
        rows = c.execute("SELECT * FROM pose_uploads WHERE person=? AND (state NOT IN ('ready','failed') OR updated > ?) "
                         "ORDER BY created DESC", (person["id"], time.time() - 86400)).fetchall()
    return [pu_row(r) for r in rows]


def may_edit_pose(person, pid):
    if person.get("admin"):
        return True
    with db() as c:
        return bool(c.execute("SELECT 1 FROM pose_uploads WHERE pose_id=? AND person=?", (pid, person["id"])).fetchone())


@app.get("/api/poses/{pid}/editable")
def pose_editable(pid: str, req: Request):
    return {"editable": may_edit_pose(who(req), pid)}


@app.post("/api/poses/{pid}/prompt")
async def set_pose_prompt(pid: str, req: Request):
    person = who(req)
    if not may_edit_pose(person, pid):
        raise HTTPException(403, "Only the person who uploaded this pose (or an admin) can edit it")
    b = await req.json()
    try:
        if b.get("ai"):
            with db() as c:
                row = c.execute("SELECT * FROM pose_uploads WHERE pose_id=?", (pid,)).fetchone()
            p = library_pose(pid) or {}
            src = row["src"] if row else (str(IMAGEGEN / p["source"]) if p.get("source") else str(POSE_LIB / "pose_images" / p.get("image", "")))
            imgs = [src] + ([str(POSE_LIB / "mannequin_images" / p["mannequin"])] if p.get("mannequin") else [])
            return {"suggestion": await asyncio.to_thread(vlm_describe, [i for i in imgs if Path(i).is_file()])}
        text = re.sub(r"\s+", " ", str(b.get("prompt") or "")).strip()
        if not text:
            raise HTTPException(400, "The description can't be empty")
        await asyncio.to_thread(ailab, "POST", "/poses/update", json={"id": pid, "prompt": text[:1000]})
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    log.info("pose %s description set by %s", pid, person["id"])
    return {"ok": True, "prompt": text}


@app.post("/api/poses/{pid}/retry")
def retry_pose(pid: str, req: Request):
    person = who(req)
    if not may_edit_pose(person, pid):
        raise HTTPException(403, "not yours")
    with _db_lock, db() as c:
        c.execute("UPDATE pose_uploads SET state='queued', detail='queued again', mq_job=NULL, updated=? "
                  "WHERE pose_id=? AND state='failed'", (time.time(), pid))
    return {"ok": True}


@app.delete("/api/poses/{pid}")
def delete_pose(pid: str, req: Request):
    person = who(req)
    if not may_edit_pose(person, pid):
        raise HTTPException(403, "Only the person who uploaded this pose (or an admin) can remove it")
    with db() as c:
        row = c.execute("SELECT state FROM pose_uploads WHERE pose_id=?", (pid,)).fetchone()
    if row and row["state"] == "mannequin":
        raise HTTPException(409, "Its mannequin is being made right now; remove it when that finishes")
    try:
        ailab("POST", "/poses/delete", json={"id": pid})
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    with _db_lock, db() as c:   # the id gets reused by AI-Lab, so forget it entirely
        c.execute("DELETE FROM pose_uploads WHERE pose_id=?", (pid,))
    log.info("pose %s removed by %s", pid, person["id"])
    return {"ok": True}


# ── image files (catalogue previews + reference uploads) ─────────────────────────────────────
@app.get("/img/{rel:path}")
def img(rel: str, req: Request, size: str = "grid"):
    who(req)
    if size not in PREVIEW_W and size != "orig":
        raise HTTPException(400)
    p = safe_path(rel)
    if size == "orig":
        return FileResponse(p, headers={"Cache-Control": "private, max-age=3600"})
    return Response(preview_bytes(p, size), media_type="image/webp", headers={"Cache-Control": "private, max-age=3600"})


# ── reference images ─────────────────────────────────────────────────────────────────────────
def ref_row(r):
    p = Path(r["path"])
    return {"id": r["id"], "name": r["name"], "w": r["w"], "h": r["h"], "created": r["created"],
            "url": img_url(p), "path": str(p)}


@app.post("/api/refs")
async def upload_refs(req: Request, files: list[UploadFile] = File(...)):
    person = who(req)
    month = time.strftime("%Y-%m")
    out = []
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"{f.filename} is over {MAX_UPLOAD // 2**20} MB")
        try:
            src = Image.open(io.BytesIO(data))
            # Read these BEFORE exif_transpose: it returns a copy with no .format.
            fmt, orient = src.format, src.getexif().get(0x0112, 1)
            im = ImageOps.exif_transpose(src)
        except Exception:
            raise HTTPException(400, f"{f.filename} is not an image")
        rid = uuid.uuid4().hex[:12]
        d = REFS_DIR / person["id"] / month
        d.mkdir(parents=True, exist_ok=True)
        # Keep a plain JPEG/PNG/WebP byte-for-byte. Re-encode as PNG (lossless) when the format is
        # anything else (HEIC from iPhones, GIF…) or when a rotation has to be baked in.
        ext = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}.get(fmt or "")
        path = d / f"{rid}{ext or '.png'}"
        if not ext or orient != 1:
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA")
            path = d / f"{rid}.png"
            im.save(path, "PNG")
        else:
            path.write_bytes(data)
        row = {"id": rid, "person": person["id"], "path": str(path), "name": f.filename or rid,
               "w": im.width, "h": im.height, "created": time.time()}
        with _db_lock, db() as c:
            c.execute("INSERT INTO refs(id,person,path,name,w,h,created) VALUES(:id,:person,:path,:name,:w,:h,:created)", row)
        out.append(ref_row(row))
        log.info("ref upload %s -> %s (%dx%d)", f.filename, path, im.width, im.height)
    return out


@app.get("/api/refs")
def list_refs(req: Request):
    person = who(req)
    with db() as c:
        rows = c.execute("SELECT * FROM refs WHERE person=? AND hidden=0 ORDER BY created DESC LIMIT 600", (person["id"],)).fetchall()
    return [ref_row(r) for r in rows if Path(r["path"]).is_file()]


@app.delete("/api/refs/{rid}")
def hide_ref(rid: str, req: Request):
    """Removes it from the library list; the file stays (a sent request may point at it)."""
    person = who(req)
    with _db_lock, db() as c:
        c.execute("UPDATE refs SET hidden=1 WHERE id=? AND person=?", (rid, person["id"]))
    return {"ok": True}


def get_ref(rid, person):
    with db() as c:
        r = c.execute("SELECT * FROM refs WHERE id=? AND person=?", (rid, person["id"])).fetchone()
    if not r or not Path(r["path"]).is_file():
        raise HTTPException(400, f"reference image {rid} is gone")
    return r


# ── templates ────────────────────────────────────────────────────────────────────────────────
@app.get("/api/templates")
def list_templates(req: Request):
    person = who(req)
    with db() as c:
        rows = c.execute("SELECT * FROM templates WHERE person=? ORDER BY updated DESC", (person["id"],)).fetchall()
    return [{"id": r["id"], "name": r["name"], "updated": r["updated"], "data": json.loads(r["data"])} for r in rows]


@app.post("/api/templates")
async def save_template(req: Request):
    person = who(req)
    b = await req.json()
    name = str(b.get("name") or "").strip()[:80]
    if not name:
        raise HTTPException(400, "name required")
    data = json.dumps(b.get("data") or {})
    with _db_lock, db() as c:
        row = c.execute("SELECT id FROM templates WHERE person=? AND name=?", (person["id"], name)).fetchone()
        tid = row["id"] if row else uuid.uuid4().hex[:12]
        c.execute("INSERT OR REPLACE INTO templates(id,person,name,data,updated) VALUES(?,?,?,?,?)",
                  (tid, person["id"], name, data, time.time()))
    return {"id": tid, "name": name, "replaced": bool(row)}


@app.delete("/api/templates/{tid}")
def delete_template(tid: str, req: Request):
    person = who(req)
    with _db_lock, db() as c:
        c.execute("DELETE FROM templates WHERE id=? AND person=?", (tid, person["id"]))
    return {"ok": True}


# ── Matrix ───────────────────────────────────────────────────────────────────────────────────
def hs():
    return CONFIG.get("matrix_homeserver", "https://matrix.deeveeyant.com").rstrip("/")


@app.get("/api/me")
def me(req: Request):
    person = who(req)
    s = sessions().get(person["matrix_user"])
    agents = [{"id": a, **CONFIG["agents"][a]} for a in person.get("agents", []) if a in CONFIG.get("agents", {})]
    return {"id": person["id"], "name": person["name"], "admin": bool(person.get("admin")),
            "restricted": bool(person.get("restricted")),
            "matrix_user": person["matrix_user"], "matrix_ready": bool(s),
            "matrix_device": (s or {}).get("device_id"), "agents": [{k: a[k] for k in ("id", "label")} for a in agents]}


# ── PIN sessions ─────────────────────────────────────────────────────────────────────────────
_pin_fail = {}          # ip -> [failure times]
_pin_lock = threading.Lock()
PIN_MAX_FAILS, PIN_WINDOW = 8, 600


@app.post("/api/pin")
async def pin_login(req: Request):
    gate(req)
    ip = client_ip(req) or "?"
    now = time.time()
    with _pin_lock:
        fails = [t for t in _pin_fail.get(ip, []) if now - t < PIN_WINDOW]
        _pin_fail[ip] = fails
        if len(fails) >= PIN_MAX_FAILS:
            raise HTTPException(429, f"Too many wrong PINs. Try again in {int(PIN_WINDOW - (now - fails[0])) // 60 + 1} min.")
    pin = str((await req.json()).get("pin") or "")
    pins = load_json(PIN_FILE, {})
    person = next((p for p in CONFIG.get("people", []) if pins.get(p["id"]) and pin_ok(pin, pins[p["id"]])), None)
    if not person:
        with _pin_lock:
            _pin_fail.setdefault(ip, []).append(now)
        log.warning("wrong PIN from %s", ip)
        raise HTTPException(401, "Wrong PIN")
    tok = uuid.uuid4().hex + uuid.uuid4().hex
    with _db_lock, db() as c:
        c.execute("INSERT INTO sessions VALUES(?,?,?,?)", (tok_hash(tok), person["id"], now, ip))
    log.info("PIN session for %s from %s", person["id"], ip)
    r = JSONResponse({"ok": True, "name": person["name"]})
    secure = req.url.scheme == "https" or req.headers.get("x-forwarded-proto") == "https"
    r.set_cookie(SESSION_COOKIE, tok, max_age=SESSION_TTL, httponly=True, samesite="lax", secure=secure)
    return r


@app.post("/api/logout")
def logout(req: Request):
    tok = req.cookies.get(SESSION_COOKIE)
    if tok:
        with _db_lock, db() as c:
            c.execute("DELETE FROM sessions WHERE token=?", (tok_hash(tok),))
    r = JSONResponse({"ok": True})
    r.delete_cookie(SESSION_COOKIE)
    return r


# ── admin: PINs and what restricted people see ──────────────────────────────────────────────
@app.get("/api/admin/people")
def admin_people(req: Request):
    admin(req)
    pins = load_json(PIN_FILE, {})
    return [{"id": p["id"], "name": p["name"], "restricted": bool(p.get("restricted")), "pin_set": p["id"] in pins}
            for p in CONFIG.get("people", [])]


@app.post("/api/admin/pin")
async def admin_pin(req: Request):
    me_ = admin(req)
    b = await req.json()
    pid, pin = str(b.get("person") or ""), str(b.get("pin") or "")
    if not person_by_id(pid):
        raise HTTPException(400, "unknown person")
    if not re.fullmatch(r"\d{4,8}", pin):
        raise HTTPException(400, "A PIN is 4 to 8 digits")
    pins = load_json(PIN_FILE, {})
    if any(pin_ok(pin, h) for k, h in pins.items() if k != pid):
        raise HTTPException(400, "Someone else already uses that PIN")
    pins[pid] = pin_hash(pin)
    save_private(PIN_FILE, pins)
    log.info("PIN for %s set by %s", pid, me_["id"])
    return {"ok": True}


@app.get("/api/admin/visibility")
def admin_visibility(person: str, req: Request):
    admin(req)
    with db() as c:
        return [f"{r['kind']}:{r['key']}" for r in c.execute("SELECT kind, key FROM visibility WHERE person=?", (person,))]


@app.post("/api/admin/visibility")
async def admin_set_visibility(req: Request):
    """{person, items: [{kind: base|ft|lora, key, on}]}"""
    me_ = admin(req)
    b = await req.json()
    pid = str(b.get("person") or "")
    if not person_by_id(pid):
        raise HTTPException(400, "unknown person")
    items = b.get("items") or []
    with _db_lock, db() as c:
        for it in items:
            kind, key = it.get("kind"), str(it.get("key") or "")
            if kind not in ("base", "ft", "lora") or not key:
                raise HTTPException(400, f"bad item {it}")
            if it.get("on"):
                c.execute("INSERT OR IGNORE INTO visibility VALUES(?,?,?)", (pid, kind, key))
            else:
                c.execute("DELETE FROM visibility WHERE person=? AND kind=? AND key=?", (pid, kind, key))
    log.info("visibility for %s: %d change(s) by %s", pid, len(items), me_["id"])
    return {"ok": True}


@app.post("/api/matrix/login")
async def matrix_login(req: Request):
    """One-time password login. Only the resulting access token is kept; the password is not."""
    person = who(req)
    b = await req.json()
    pw = str(b.get("password") or "")
    if not pw:
        raise HTTPException(400, "password required")
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{hs()}/_matrix/client/v3/login", json={
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": person["matrix_user"]},
            "password": pw, "initial_device_display_name": "Image Request page"})
    if r.status_code != 200:
        log.warning("matrix login for %s failed: %s %s", person["matrix_user"], r.status_code, r.text[:200])
        raise HTTPException(401, (r.json().get("error") if r.headers.get("content-type", "").startswith("application/json") else None) or "login failed")
    d = r.json()
    s = sessions()
    s[person["matrix_user"]] = {"access_token": d["access_token"], "device_id": d.get("device_id"), "created": time.time()}
    save_sessions(s)
    log.info("matrix session created for %s (device %s)", person["matrix_user"], d.get("device_id"))
    return {"ok": True, "device_id": d.get("device_id")}


async def mx(c, method, path, tok, **kw):
    headers = {"Authorization": f"Bearer {tok}", **kw.pop("headers", {})}
    r = await c.request(method, f"{hs()}{path}", headers=headers, **kw)
    if r.status_code == 401:
        raise HTTPException(401, "Your Matrix session for this page has expired. Connect Matrix again.")
    if r.status_code >= 400:
        raise HTTPException(502, f"Matrix {path.split('?')[0]}: {r.status_code} {r.text[:200]}")
    return r.json()


async def upload_mxc(c, tok, path: Path, max_w=1280):
    im = ImageOps.exif_transpose(Image.open(path))
    if im.mode not in ("RGB",):
        im = im.convert("RGB")
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=86)
    d = await mx(c, "POST", f"/_matrix/media/v3/upload?filename={path.stem}.jpg", tok,
                 content=buf.getvalue(), headers={"Content-Type": "image/jpeg"})
    return d["content_uri"], im.width, im.height


def esc(s):
    return html.escape(str(s or ""), quote=True)


@app.post("/api/send")
async def send(req: Request):
    person = who(req)
    b = await req.json()
    agent_id = b.get("agent")
    if agent_id not in person.get("agents", []) or agent_id not in CONFIG.get("agents", {}):
        raise HTTPException(400, "unknown agent")
    agent = CONFIG["agents"][agent_id]
    sess = sessions().get(person["matrix_user"])
    if not sess:
        raise HTTPException(401, "Connect Matrix first")
    request_text = str(b.get("request") or "").strip()
    if not request_text:
        raise HTTPException(400, "Describe what you want generated")
    al = allowed(person)
    m = visible_model(person, b.get("model")) if b.get("model") else None
    ft, use_base = None, b.get("finetune") == "base"
    if use_base:
        if not m or not can_see(al, "base", m["id"]):
            raise HTTPException(400, "The base model isn't available here")
    elif b.get("finetune"):
        if not m:
            raise HTTPException(400, "A finetune needs its base model")
        ft = next((f for f in finetunes(m) if f["id"] == b["finetune"]), None)
        if not ft or not can_see(al, "ft", m["id"], ft["id"]):
            raise HTTPException(400, "That finetune is no longer downloaded")
    loras = []
    if b.get("loras"):
        if not m:
            raise HTTPException(400, "LoRAs need a model")
        idx = {x["id"]: x for x in lora_index(m)}
        for lid in b["loras"]:
            if lid not in idx or not can_see(al, "lora", m["id"], lid):
                raise HTTPException(400, f"LoRA {lid} not found")
            loras.append(idx[lid])
    pose = None
    if b.get("pose") is not None:
        pose = load_pose(int(b["pose"]))
        if not pose:
            raise HTTPException(400, f"pose {b['pose']} not found")
    refs = []
    for r in b.get("refs") or []:
        row = get_ref(r.get("id"), person)
        refs.append((row, str(r.get("note") or "").strip()))
    if refs and not (m and m.get("refs")):
        raise HTTPException(400, "The selected model doesn't take reference images")
    if m and refs and len(refs) > (m.get("max_refs") or 0):
        raise HTTPException(400, f"{m['name']} takes at most {m['max_refs']} reference images")

    tok = sess["access_token"]
    lines, parts = [], []
    lines.append("🎨 Image request (sent from the Image Request page)")
    parts.append("<p><b>🎨 Image request</b> <i>(sent from the Image Request page)</i></p>")
    async with httpx.AsyncClient(timeout=60) as c:
        # Model
        if m:
            caps = []
            if m.get("edit"):
                caps.append("edit-capable")
            if m.get("refs"):
                caps.append(f"takes up to {m['max_refs']} reference images")
            lines += ["", f"BASE MODEL: {m['name']}" + (f" ({', '.join(caps)})" if caps else "")]
            if m.get("agent_hint"):
                lines.append(f"  Note: {m['agent_hint']}")
            ft_html = ""
            if ft:
                label = ft["name"] + (f" ({ft['version']})" if ft["version"] else "")
                lines.append(f"FINETUNE: {label}")
                for f in ft["files"]:
                    lines.append(f"  file: {f['path']}  ({f['size'] / 1e9:.2f} GB)")
                if len(ft["files"]) > 1:
                    lines.append("  (several files = precision variants of the same finetune; pick what fits the GPU)")
                if ft["civitai_url"]:
                    lines.append(f"  civitai: {ft['civitai_url']}")
                ft_html = f" › {esc(label)}"
            elif use_base:
                lines.append(f"FINETUNE: none. Use the official {m['name']} base model itself, not a finetune; "
                             "which quant / precision is your choice.")
                ft_html = " › base model"
            else:
                lines.append(f"FINETUNE: your choice, from {', '.join(str(IMAGEGEN / d) for d in m.get('dirs', []))}")
            parts.append(f"<p><b>Model:</b> {esc(m['name'])}{ft_html}" + (f" <i>({esc(', '.join(caps))})</i>" if caps else "") + "</p>")
        else:
            lines += ["", "MODEL: your choice"]
            parts.append("<p><b>Model:</b> your choice</p>")
        # LoRAs
        if loras:
            lines += ["", "LORAS:"]
            li = []
            for i, x in enumerate(loras, 1):
                tw = ", ".join(x.get("trained_words") or [])
                lines.append(f"  {i}. {x['name']}" + (f" ({x['version']})" if x.get("version") else "") + f" [{x['layer']}]")
                lines.append(f"     file: {IMAGEGEN / x['path']}")
                if tw:
                    lines.append(f"     trigger words: {tw}")
                li.append(f"<li>{esc(x['name'])} <i>[{esc(x['layer'])}]</i>" + (f" — <code>{esc(tw)}</code>" if tw else "") + "</li>")
            parts.append(f"<p><b>LoRAs:</b></p><ul>{''.join(li)}</ul>")
        # Pose
        if pose:
            pf = pose_files(pose)
            lines += ["", f"POSE: #{pose['index']} {pose.get('name') or ''}".rstrip()]
            if pose.get("prompt"):
                lines.append(f"  pose description: {pose['prompt']}")
            if pose.get("view"):
                lines.append(f"  view: {pose['view']}")
            for k, v in pf.items():
                lines.append(f"  {k}: {v}")
            thumb = ""
            src = pf.get("mannequin") or pf.get("thumbnail")
            if src:
                mxc, w, h = await upload_mxc(c, tok, Path(src), 640)
                thumb = f'<br><img src="{mxc}" alt="pose {pose["index"]}" height="160">'
            parts.append(f"<p><b>Pose:</b> #{pose['index']} {esc(pose.get('prompt') or pose.get('name'))}{thumb}</p>")
        # Reference images
        if refs:
            lines += ["", "REFERENCE IMAGES (files on CT152):"]
            li = []
            for i, (row, note) in enumerate(refs, 1):
                lines.append(f"  {i}. {row['path']}  ({row['w']}x{row['h']})")
                lines.append(f"     use: {note}" if note else "     use: (no note; infer from the request)")
                mxc, w, h = await upload_mxc(c, tok, Path(row["path"]))
                li.append(f'<li><img src="{mxc}" alt="reference {i}" height="160"><br>'
                          f'<b>Ref {i}:</b> {esc(note) if note else "<i>no note</i>"}</li>')
            parts.append(f"<p><b>Reference images:</b></p><ol>{''.join(li)}</ol>")
        # Request
        lines += ["", "REQUEST:", request_text]
        parts.append("<p><b>Request:</b></p><p>" + esc(request_text).replace("\n", "<br>") + "</p>")

        body = "\n".join(lines)
        content = {"msgtype": "m.text", "body": body, "format": "org.matrix.custom.html",
                   "formatted_body": "".join(parts), "ai.deeveeyant.image_request": {"version": 1}}
        txn = uuid.uuid4().hex
        d = await mx(c, "PUT", f"/_matrix/client/v3/rooms/{agent['room']}/send/m.room.message/{txn}", tok, json=content)
    hid = uuid.uuid4().hex[:12]
    with _db_lock, db() as cc:
        cc.execute("INSERT INTO history VALUES(?,?,?,?,?,?,?)",
                   (hid, person["id"], agent_id, d.get("event_id"), json.dumps(b), body, time.time()))
    log.info("sent request %s to %s as %s (event %s, %d loras, pose %s, %d refs)",
             hid, agent_id, person["matrix_user"], d.get("event_id"), len(loras), pose and pose["index"], len(refs))
    return {"ok": True, "event_id": d.get("event_id"), "agent": agent["label"], "body": body}


# ── page ─────────────────────────────────────────────────────────────────────────────────────
@app.get("/")
def index(req: Request):
    try:
        gate(req)
    except HTTPException as e:
        return Response(f"<h3>{esc(e.detail)}</h3>", e.status_code, media_type="text/html")
    return FileResponse(HERE / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
def healthz():
    return {"ok": True, "models": len(MODELS)}
