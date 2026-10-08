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
GET  /train/options | /train/runs | /train/status?dataset=&run=
POST /train  {"dataset","run_name","base_model","gpu":"5060ti-3","epochs",...}
POST /train/stop | /train/install
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

# Detector training. Separate module because it is a different lifecycle: /segment is
# interactive and holds the GPU lock for milliseconds, training runs detached for tens of
# minutes on its own card and is tracked entirely through files on disk.
_tspec = importlib.util.spec_from_file_location("trainer", os.path.join(os.path.dirname(__file__), "trainer.py"))
trainer = importlib.util.module_from_spec(_tspec); _tspec.loader.exec_module(trainer)

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


def _polys(mask, w, h, min_area=200, simplify=0.004, max_polys=4):
    mm = (mask * 255).astype("uint8")
    cnts, _ = cv2.findContours(mm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:max(1, int(max_polys))]:
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
        import glob as _glob
        for hp in sorted(_glob.glob(os.path.join(d, "holdout*.txt"))):
            holdout |= {l.strip() for l in open(hp) if l.strip()}
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

    def _detect(self):
        """Run one ultralytics detector over whole images (AI-Lab training-image Auto-crop).

        Body: {detector: <path to .pt under IMAGEGEN>, rels: [imagegen-relative paths], conf}.
        Returns {results: [{rel, w, h, dets: [{box: [x1,y1,x2,y2] source px, conf}]}]}, best first.
        A segmentation model's box is tightened to its MASK, which hugs the garment better than the
        detection box. Shares the GPU lock with /segment; keep batches small (the caller chunks).
        """
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            det_path = os.path.normpath(os.path.join(IMAGEGEN, str(req.get("detector", "")).lstrip("/")))
            if not det_path.startswith(IMAGEGEN + os.sep) or not det_path.endswith(".pt") or not os.path.exists(det_path):
                return self._send(400, {"error": "detector must be an existing .pt under the imagegen root"})
            conf = float(req.get("conf", 0.25))
            rels = [str(r) for r in (req.get("rels") or [])][:32]
            paths, out = [], []
            for rel in rels:
                ap = os.path.normpath(os.path.join(IMAGEGEN, rel.lstrip("/")))
                if not ap.startswith(IMAGEGEN + os.sep) or not os.path.isfile(ap):
                    out.append({"rel": rel, "error": "not found"})
                else:
                    paths.append((rel, ap))
            if paths:
                det = _detector(det_path)
                with _lock:                              # one GPU, shared with /segment
                    res = det.predict([ap for _, ap in paths], conf=conf, device=DEV, verbose=False)
                for (rel, _), r in zip(paths, res):
                    h, w = r.orig_shape
                    dets = []
                    boxes = r.boxes
                    if boxes is not None and len(boxes):
                        xyxy = boxes.xyxy.cpu().numpy(); cs = boxes.conf.cpu().numpy()
                        ms = r.masks.data.cpu().numpy() if r.masks is not None else None
                        for i in range(len(cs)):
                            x1, y1, x2, y2 = [float(v) for v in xyxy[i]]
                            if ms is not None and i < len(ms):
                                m = ms[i]; ys, xs = np.nonzero(m)
                                if len(xs):              # mask is at model res: scale to the source
                                    sx, sy = w / m.shape[1], h / m.shape[0]
                                    x1, y1, x2, y2 = xs.min() * sx, ys.min() * sy, (xs.max() + 1) * sx, (ys.max() + 1) * sy
                            dets.append({"box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)], "conf": round(float(cs[i]), 4)})
                    dets.sort(key=lambda d: -d["conf"])
                    out.append({"rel": rel, "w": int(w), "h": int(h), "dets": dets})
            return self._send(200, {"results": out})
        except Exception as e:
            return self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _query(self):
        from urllib.parse import urlparse, parse_qs
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "device": DEV, "cached": len(_cache)})
        if self.path.startswith("/train/options"):
            # Everything the launcher needs to offer a choice, in one round trip: which
            # datasets have labelled tiles, which weights may be fine-tuned, and which card
            # has room. Separate calls would let the UI show a GPU roster from ten minutes ago.
            return self._send(200, {"datasets": trainer.list_datasets(),
                                    "base_models": trainer.list_base_models(),
                                    "gpus": trainer.gpu_inventory()})
        if self.path.startswith("/train/runs"):
            q = self._query()
            return self._send(200, {"runs": trainer.list_runs(q.get("dataset") or None)})
        if self.path.startswith("/train/status"):
            q = self._query()
            st = trainer.status(q.get("dataset", ""), q.get("run", ""))
            return self._send(200 if st else 404, st or {"error": "no such run"})
        if self.path.startswith("/job/"):
            jid = self.path.split("/job/", 1)[1].split("?")[0]
            with _jobs_lock:
                j = _jobs.get(jid)
            return self._send(200 if j else 404, j or {"error": "no such job"})
        self._send(404, {"error": "not found"})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        if self.path.startswith("/train/stop"):
            try:
                b = self._body()
            except Exception as e:
                return self._send(400, {"error": str(e)})
            job, err = trainer.stop(b.get("dataset", ""), b.get("run", ""))
            return self._send(200 if job else 400, job or err)
        if self.path.startswith("/train/install"):
            try:
                b = self._body()
            except Exception as e:
                return self._send(400, {"error": str(e)})
            ok, err = trainer.install(b.get("dataset", ""), b.get("run", ""), b.get("filename", ""))
            return self._send(200 if ok else 400, ok or err)
        if self.path.rstrip("/") == "/train":
            try:
                b = self._body()
            except Exception as e:
                return self._send(400, {"error": str(e)})
            job, err = trainer.start(b)
            # 400 carries the WHY (which card, how much free, what is holding it) so the UI
            # can render an actionable refusal rather than "request failed".
            return self._send(202 if job else 400, job or err)
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
        if self.path.startswith("/detect"):
            return self._detect()
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
                polys = _polys(masks[k], W, H, max_polys=int(req.get("max_polys", 4)))
            return self._send(200, {"polys": [{"pts": p, "score": round(float(scores[k]), 4)}
                                              for p in polys]})
        except Exception as e:
            return self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
