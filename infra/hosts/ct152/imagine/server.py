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

Access: a valid Cloudflare Access JWT (the public hostname), or a LAN/tailnet client on the
AI-Lab trusted-source list. Both map to a person in config.json, whose Matrix account is used.
"""
import asyncio
import hashlib
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


def person_by_email(email):
    for p in CONFIG.get("people", []):
        if email and email.lower() in [e.lower() for e in p.get("emails", [])]:
            return p
    return None


def default_person():
    return next((p for p in CONFIG.get("people", []) if p.get("lan_default")), None)


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


def who(req: Request):
    email = cf_email(req)
    if email:
        p = person_by_email(email)
        if p:
            return p
        raise HTTPException(403, f"{email} is not set up for this page")
    ip = client_ip(req)
    if trusted_ip(ip):
        p = default_person()
        if p:
            return p
    log.warning("refused %s %s (ip %s, no Access identity)", req.method, req.url.path, ip)
    raise HTTPException(403, "Open this page through its Cloudflare address, or from a trusted device")


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
    """)

SESS_FILE = STATE_DIR / "matrix-sessions.json"


def sessions():
    return load_json(SESS_FILE, {})


def save_sessions(s):
    tmp = SESS_FILE.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(s, f, indent=2)
    os.replace(tmp, SESS_FILE)


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


@app.get("/api/models")
def api_models(req: Request):
    who(req)
    out = []
    for m in MODELS:
        s = model_images(m)
        out.append({k: m.get(k) for k in ("id", "name", "family", "edit", "refs", "max_refs", "description", "best_for", "notes")}
                   | {"cover": img_url(s["images"][0]) if s["images"] else None,
                      "image_count": len(s["images"]), "file_count": len(s["files"])})
    return out


@app.get("/api/models/{mid}")
def api_model(mid: str, req: Request):
    who(req)
    m = model_by_id(mid)
    s = model_images(m)
    return {"images": [img_url(p) for p in s["images"][:400]], "files": s["files"]}


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
    return {
        "name": full.get("name") or (civ.get("model") or {}).get("name") or side.get("model_name") or w.stem,
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
    who(req)
    keep = ("id", "path", "file", "cover", "name", "version", "layer", "trained_words", "nsfw")
    return [{k: x.get(k) for k in keep} for x in lora_index(model_by_id(model))]


@app.get("/api/loras/{model}/{lid}")
def api_lora(model: str, lid: str, req: Request):
    who(req)
    x = next((x for x in lora_index(model_by_id(model)) if x["id"] == lid), None)
    if not x:
        raise HTTPException(404, "unknown LoRA")
    return x


# ── poses (read through poses-site, the library's single reader) ─────────────────────────────
@app.get("/api/poses")
async def api_poses(req: Request):
    who(req)
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{POSES_URL}/api/poses")
    return Response(r.content, r.status_code, media_type="application/json")


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
    return {"name": person["name"], "matrix_user": person["matrix_user"], "matrix_ready": bool(s),
            "matrix_device": (s or {}).get("device_id"), "agents": [{k: a[k] for k in ("id", "label")} for a in agents]}


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
    m = model_by_id(b.get("model")) if b.get("model") else None
    loras = []
    if b.get("loras"):
        if not m:
            raise HTTPException(400, "LoRAs need a model")
        idx = {x["id"]: x for x in lora_index(m)}
        for lid in b["loras"]:
            if lid not in idx:
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
            lines += ["", f"MODEL: {m['name']}" + (f" ({', '.join(caps)})" if caps else ""),
                      f"  Model folder(s): {', '.join(str(IMAGEGEN / d) for d in m.get('dirs', []))}"]
            if m.get("agent_hint"):
                lines.append(f"  Note: {m['agent_hint']}")
            parts.append(f"<p><b>Model:</b> {esc(m['name'])}" + (f" <i>({esc(', '.join(caps))})</i>" if caps else "") + "</p>")
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
        who(req)
    except HTTPException as e:
        return Response(f"<h3>{esc(e.detail)}</h3>", e.status_code, media_type="text/html")
    return FileResponse(HERE / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
def healthz():
    return {"ok": True, "models": len(MODELS)}
