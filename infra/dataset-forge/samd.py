#!/usr/bin/env python3
"""samd — a tiny SAM point-prompt service, so a human can annotate what the detector missed.

WHY A SERVICE. SAM needs the GPU, which is on ai-epyc; the AI-Lab backend runs on CT152 and
proxies here. And the ViT encode is ~all of SAM's cost (~1s) while the mask decode is
milliseconds, so the encoder output is CACHED PER TILE: the first click on a tile pays the
encode, every later click on that tile is instant. A stateless "encode per request" design
would make interactive annotation unusable.

POST /segment  {"dataset":"panties","tile":"foo_t1.png",
                "points":[{"x":0.51,"y":0.62,"label":1}],  # normalised 0..1, label 0 = exclude
                "box":[x1,y1,x2,y2]}                        # optional, normalised
  -> {"polys":[{"pts":[[x,y],...],"score":0.97}]}
GET  /health
"""
import json, os, sys, threading, uuid, time, importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from collections import OrderedDict

os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
import warnings; warnings.filterwarnings("ignore")
import numpy as np, cv2, torch
from PIL import Image
from segment_anything import sam_model_registry, SamPredictor

ROOT = os.environ.get("FORGE_DATASETS", "/imagegen/_datasets")
CKPT = os.environ.get("FORGE_SAM", "/imagegen/sam/sam_vit_h_4b8939.pth")
DEV  = int(os.environ.get("FORGE_DEVICE", "2"))
PORT = int(os.environ.get("FORGE_PORT", "8791"))
CACHE_N = 8

# The tiling + seeding + polygon extraction is forge.py's, imported rather than reimplemented:
# the UI's "Add images" and the CLI's `annotate` must not drift into producing different data.
_spec = importlib.util.spec_from_file_location("forge", os.path.join(os.path.dirname(__file__), "forge.py"))
forge = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(forge)

IMAGEGEN = os.environ.get("FORGE_IMAGEGEN", "/imagegen")
_jobs = {}                    # id -> {state, done, total, added, error, dataset}
_jobs_lock = threading.Lock()
_dets = {}                    # detector path -> loaded YOLO (loading one costs seconds)

_lock = threading.Lock()
_cache = OrderedDict()          # tile path -> the predictor's encoded image state
print("loading SAM %s on cuda:%d ..." % (os.path.basename(CKPT), DEV), flush=True)
_sam = sam_model_registry["vit_h"](checkpoint=CKPT).to(f"cuda:{DEV}")
_pred = SamPredictor(_sam)
print("ready on :%d" % PORT, flush=True)


def _set_image(path):
    """Encode `path` unless its features are already the ones loaded."""
    if _cache and next(reversed(_cache)) == path:
        return                                   # already current — the common case
    if path in _cache:
        _pred.features, _pred.original_size, _pred.input_size = _cache[path]
        _pred.is_image_set = True
        _cache.move_to_end(path)
        return
    arr = np.array(Image.open(path).convert("RGB"))
    _pred.set_image(arr)
    _cache[path] = (_pred.features, _pred.original_size, _pred.input_size)
    _cache.move_to_end(path)
    while len(_cache) > CACHE_N:
        _cache.popitem(last=False)


def _polys(mask, w, h, min_area=200, simplify=0.004):
    mm = (mask * 255).astype("uint8")
    cnts, _ = cv2.findContours(mm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:4]:
        if cv2.contourArea(c) < min_area:
            continue
        c = cv2.approxPolyDP(c, simplify * cv2.arcLength(c, True), True).reshape(-1, 2)
        if len(c) >= 3:
            out.append([[round(float(x) / w, 6), round(float(y) / h, 6)] for x, y in c])
    return out


def _detector(path):
    from ultralytics import YOLO
    if path not in _dets:
        _dets[path] = YOLO(path)
    return _dets[path]


def _ingest(job_id, ds, rels, detector, unseeded, conf):
    """Tile + seed + merge, then write the manifest. Runs on a worker thread."""
    d = os.path.join(ROOT, ds)
    man_p = os.path.join(d, "manifest.json")
    try:
        os.makedirs(d, exist_ok=True)
        man = json.load(open(man_p)) if os.path.exists(man_p) else {"terms": [], "items": [], "tiles": []}
        have = {i["path"] for i in man.get("items", [])}
        holdout = set()
        hp = os.path.join(d, "holdout.txt")
        if os.path.exists(hp):
            holdout = {l.strip() for l in open(hp) if l.strip()}
        items, skipped, held = [], 0, 0
        for rel in rels:
            # paths arrive RELATIVE to the imagegen root, so the same request works whichever
            # host resolves it (/ai-assets/imagegen on CT152, /imagegen here)
            ap = os.path.normpath(os.path.join(IMAGEGEN, rel.lstrip("/")))
            if not ap.startswith(IMAGEGEN + os.sep) or not os.path.exists(ap):
                skipped += 1; continue
            if ap in have:
                skipped += 1; continue
            if ap in holdout:
                held += 1; continue        # frozen benchmark — never trainable
            items.append({"path": ap})
        with _jobs_lock:
            _jobs[job_id].update(total=len(items), skipped=skipped, heldout=held, state="running")
        if items:
            det = _detector(detector)
            with _lock:                              # share the GPU with /segment
                out = forge.annotate_images(
                    items, det, _pred,
                    os.path.join(d, "tiles"), os.path.join(d, "overlays"),
                    device=DEV, conf=conf, unseeded=unseeded,
                    progress=lambda n, t: _jobs[job_id].update(done=n))
            man["items"] = (man.get("items") or []) + items
            man = forge.merge_tiles(man, out, append=True)
            tmp = man_p + ".tmp"
            json.dump(man, open(tmp, "w"), indent=1)
            os.replace(tmp, man_p)                   # never leave a torn manifest
            with _jobs_lock:
                _jobs[job_id].update(added=len(out))
        with _jobs_lock:
            _jobs[job_id].update(state="done", done=_jobs[job_id]["total"])
    except Exception as e:
        with _jobs_lock:
            _jobs[job_id].update(state="error", error="%s: %s" % (type(e).__name__, e))
    finally:
        _cache.clear()        # tiles changed; stale encoder features would segment the wrong image


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep the journal readable
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "device": DEV, "cached": len(_cache)})
        if self.path.startswith("/job/"):
            jid = self.path.split("/job/", 1)[1].split("?")[0]
            with _jobs_lock:
                j = _jobs.get(jid)
            return self._send(200 if j else 404, j or {"error": "no such job"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/ingest"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(n) or b"{}")
            except Exception as e:
                return self._send(400, {"error": str(e)})
            ds = str(req.get("dataset", ""))
            if not ds or not ds.replace("_", "").replace("-", "").replace(".", "").isalnum():
                return self._send(400, {"error": "bad dataset name"})
            rels = req.get("paths") or []
            if not rels:
                return self._send(400, {"error": "no paths"})
            if len(rels) > 2000:
                return self._send(400, {"error": "too many paths in one request (max 2000)"})
            det = req.get("detector") or os.environ.get("FORGE_DETECTOR", "")
            if not det or not os.path.exists(det):
                return self._send(400, {"error": "detector not found: %r" % det})
            jid = uuid.uuid4().hex[:12]
            with _jobs_lock:
                _jobs[jid] = {"id": jid, "dataset": ds, "state": "queued", "done": 0,
                              "total": len(rels), "added": 0, "skipped": 0,
                              "started": int(time.time())}
            threading.Thread(target=_ingest, daemon=True, args=(
                jid, ds, rels, det, req.get("unseeded", "unlabelled"),
                float(req.get("conf", 0.15)))).start()
            return self._send(202, {"job": jid})
        if not self.path.startswith("/segment"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            ds, tile = req.get("dataset", ""), req.get("tile", "")
            if not ds.replace("_", "").replace("-", "").replace(".", "").isalnum():
                return self._send(400, {"error": "bad dataset"})
            if os.path.basename(tile) != tile:
                return self._send(400, {"error": "bad tile"})
            path = os.path.join(ROOT, ds, "tiles", tile)
            if not os.path.exists(path):
                return self._send(404, {"error": "no such tile"})
            pts = req.get("points") or []
            box = req.get("box")
            if not pts and not box:
                return self._send(400, {"error": "points or box required"})

            with _lock:                       # one GPU, one request at a time
                _set_image(path)
                W, H = _pred.original_size[1], _pred.original_size[0]
                kw = {"multimask_output": bool(req.get("multimask", False))}
                if pts:
                    kw["point_coords"] = np.array([[p["x"] * W, p["y"] * H] for p in pts])
                    kw["point_labels"] = np.array([int(p.get("label", 1)) for p in pts])
                if box:
                    kw["box"] = np.array([box[0] * W, box[1] * H, box[2] * W, box[3] * H])
                masks, scores, _ = _pred.predict(**kw)
                k = int(np.argmax(scores))
                polys = _polys(masks[k], W, H)
            return self._send(200, {"polys": [{"pts": p, "score": round(float(scores[k]), 4)}
                                              for p in polys]})
        except Exception as e:
            return self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
