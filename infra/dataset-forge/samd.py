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
import json, os, sys, threading
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
        self._send(404, {"error": "not found"})

    def do_POST(self):
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
