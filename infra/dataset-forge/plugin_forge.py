"""Dataset Forge as an ailab-modelsvc PLUGIN (claude1; deployed as /opt/ailab-modelsvc/plugins/forge.py).

Travis, 2026-10-09: fold Dataset Forge into the Image Model Service instead of running it as its own
service. claude2 owns serve.py; this file is AI-Lab's (repo: infra/dataset-forge/plugin_forge.py).

The "detector" and "sam" kinds and the inference routes (/v1/detect, /v1/sam) belong to claude2's
plugins/detect.py, which loads first (alphabetical). This plugin adds only the CURATION routes AI-Lab's
Dataset Review / detector training use, on top of those kinds - same request shapes as the old samd:
    /forge/segment /forge/detect /forge/ingest /forge/job?id= /forge/health
    /forge/train /forge/train/options|runs|status|stop|install
Detector objects are {"model": YOLO, ...}; SAM objects {"model", "predictor", "image_key", ...} where
image_key names the image whose embedding the predictor currently holds (kept honest here so
/v1/sam never reuses an embedding this plugin overwrote).
The curation code (tiling/seeding + the trainer) is imported from FORGE_HOME (/opt/dataset-forge), so
the CLI, the old samd and this plugin can never drift apart.
"""
import importlib.util
import json
import os
import threading
import time
import uuid
import numpy as np

FORGE_HOME = os.environ.get("FORGE_HOME", "/opt/dataset-forge")
IMAGEGEN = os.environ.get("FORGE_IMAGEGEN", "/imagegen")
DATASETS = os.environ.get("FORGE_DATASETS", os.path.join(IMAGEGEN, "_datasets"))
DEFAULT_SAM = os.environ.get("FORGE_SAM_NAME", "sam_vit_h_4b8939.pth")
INGEST_CHUNK = 8          # images per GPU-queue slot during /forge/ingest: never hog a card for minutes


def _load_mod(name, file):
    p = os.path.join(FORGE_HOME, file)
    if not os.path.exists(p):
        return None
    spec = importlib.util.spec_from_file_location(name, p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod



def _det_name(s):
    """Accept 'segm/x.pt', 'ultralytics/segm/x.pt' or '/imagegen/ultralytics/segm/x.pt'."""
    s = str(s or "").strip()
    for pre in (IMAGEGEN.rstrip("/") + "/", "/ai-assets/imagegen/", "ultralytics/"):
        if s.startswith(pre):
            s = s[len(pre):]
    if s.startswith("ultralytics/"):
        s = s[len("ultralytics/"):]
    if not s or ".." in s.split("/"):
        raise RuntimeError("bad detector name")
    return s


def _safe_ds(ds):
    ds = str(ds or "")
    if not ds or not ds.replace("_", "").replace("-", "").replace(".", "").isalnum():
        raise RuntimeError("bad dataset name")
    return ds


def register(api):
    forge = _load_mod("forge_lib", "forge.py")
    trainer = _load_mod("forge_trainer", "trainer.py")
    if not forge or not trainer:
        api.log(f"curation code not found in {FORGE_HOME}: /forge/ingest and /forge/train* will refuse (inference routes still work)")

    # ── curation: the old samd routes, under /forge (kinds "detector"/"sam" come from plugins/detect.py) ──

    def sam_encode(obj, key, load_rgb):
        """Encode unless the predictor already holds this image; record what it holds in image_key."""
        if obj.get("image_key") != key:
            obj["predictor"].set_image(load_rgb(), image_format="RGB")
            obj["image_key"] = key
    jobs, jobs_lock = {}, threading.Lock()

    def f_health(body, query):
        return {"ok": True, "plugin": "forge", "curation": bool(forge and trainer), "datasets": DATASETS, "default_sam": DEFAULT_SAM}

    def f_segment(body, query):
        """{dataset, tile, points:[{x,y,label}] (0..1), box?:[x1,y1,x2,y2] (0..1), multimask?, max_polys?, sam?}"""
        ds = _safe_ds(body.get("dataset"))
        tile = str(body.get("tile") or "")
        if not tile or os.path.basename(tile) != tile:
            return 400, {"error": "bad tile"}
        path = os.path.join(DATASETS, ds, "tiles", tile)
        if not os.path.exists(path):
            return 404, {"error": "no such tile"}
        pts, box = body.get("points") or [], body.get("box")
        if not pts and not box:
            return 400, {"error": "points or box required"}

        def go(obj, device):
            import cv2
            from PIL import Image
            sam_encode(obj, "forge-tile:%s:%d" % (path, int(os.path.getmtime(path))), lambda: np.array(Image.open(path).convert("RGB")))
            H, W = obj["predictor"].original_size
            kw = {"multimask_output": bool(body.get("multimask", False))}
            if pts:
                kw["point_coords"] = np.array([[p["x"] * W, p["y"] * H] for p in pts])
                kw["point_labels"] = np.array([int(p.get("label", 1)) for p in pts])
            if box:
                kw["box"] = np.array([box[0] * W, box[1] * H, box[2] * W, box[3] * H])
            masks, scores, _ = obj["predictor"].predict(**kw)
            k = int(np.argmax(scores))
            mm = (masks[k] * 255).astype("uint8")
            cnts, _ = cv2.findContours(mm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            polys = []
            for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:max(1, int(body.get("max_polys", 4)))]:
                if cv2.contourArea(c) < 200:
                    continue
                c = cv2.approxPolyDP(c, 0.004 * cv2.arcLength(c, True), True).reshape(-1, 2)
                if len(c) >= 3:
                    polys.append([[round(float(x) / W, 6), round(float(y) / H, 6)] for x, y in c])
            return {"polys": [{"pts": p, "score": round(float(scores[k]), 4)} for p in polys]}
        return api.run("sam", str(body.get("sam") or DEFAULT_SAM), go, who="forge-segment")

    def f_detect(body, query):
        """Old samd /detect: {detector, rels:[imagegen-relative paths], conf} -> {results:[{rel,w,h,dets}]}."""
        name = _det_name(body.get("detector"))
        conf = float(body.get("conf", 0.25))
        rels = [str(r) for r in (body.get("rels") or [])][:32]
        paths, out = [], []
        for rel in rels:
            ap = os.path.normpath(os.path.join(IMAGEGEN, rel.lstrip("/")))
            if not ap.startswith(IMAGEGEN + os.sep) or not os.path.isfile(ap):
                out.append({"rel": rel, "error": "not found"})
            else:
                paths.append((rel, ap))
        if not paths:
            return {"results": out}

        def go(obj, device):
            res = obj["model"].predict([ap for _, ap in paths], conf=conf, device=device.index if device.type == "cuda" else "cpu", verbose=False)
            for (rel, _), r in zip(paths, res):
                h, w = r.orig_shape
                dets = []
                ms = r.masks.data.cpu().numpy() if r.masks is not None else None
                for i, b in enumerate(r.boxes or []):
                    x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
                    if ms is not None and i < len(ms):    # tighten to the mask (hugs the garment better)
                        m = ms[i]; ys, xs = np.nonzero(m)
                        if len(xs):
                            sx, sy = w / m.shape[1], h / m.shape[0]
                            x1, y1, x2, y2 = xs.min() * sx, ys.min() * sy, (xs.max() + 1) * sx, (ys.max() + 1) * sy
                    dets.append({"box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)], "conf": round(float(b.conf), 4)})
                dets.sort(key=lambda d: -d["conf"])
                out.append({"rel": rel, "w": int(w), "h": int(h), "dets": dets})
            return out
        api.run("detector", name, go, who="forge-detect")
        return {"results": out}

    def _ingest(jid, ds, rels, det_name, sam_name, unseeded, conf):
        d = os.path.join(DATASETS, ds)
        man_p = os.path.join(d, "manifest.json")
        try:
            import glob
            os.makedirs(d, exist_ok=True)
            man = json.load(open(man_p)) if os.path.exists(man_p) else {"terms": [], "items": [], "tiles": []}
            have = {i["path"] for i in man.get("items", [])}
            holdout = set()
            for hp in sorted(glob.glob(os.path.join(d, "holdout*.txt"))):
                holdout |= {l.strip() for l in open(hp) if l.strip()}
            items, skipped, held = [], 0, 0
            for rel in rels:
                ap = os.path.normpath(os.path.join(IMAGEGEN, rel.lstrip("/")))
                if not ap.startswith(IMAGEGEN + os.sep) or not os.path.exists(ap) or ap in have:
                    skipped += 1; continue
                if ap in holdout:
                    held += 1; continue
                items.append({"path": ap})
            with jobs_lock:
                jobs[jid].update(total=len(items), skipped=skipped, heldout=held, state="running")
            tiles = []
            g = api.placement("sam", sam_name)          # detector and SAM on the SAME card
            for start in range(0, len(items), INGEST_CHUNK):
                chunk = items[start:start + INGEST_CHUNK]

                def work(gg, chunk=chunk, start=start):
                    det = api.model("detector", det_name, gpu=gg)
                    sam = api.model("sam", sam_name, gpu=gg)
                    sam["image_key"] = None             # annotate_images drives the predictor itself
                    try:
                        return forge.annotate_images(chunk, det["model"], sam["predictor"], os.path.join(d, "tiles"), os.path.join(d, "overlays"),
                                                     device=gg, conf=conf, unseeded=unseeded,
                                                     progress=lambda n, t: jobs[jid].update(done=start + n))
                    finally:
                        sam["image_key"] = None
                tiles += api.on_gpu(g, work, who="forge-ingest")
            if items:
                man["items"] = (man.get("items") or []) + items
                man = forge.merge_tiles(man, tiles, append=True)
                tmp = man_p + ".tmp"
                json.dump(man, open(tmp, "w"), indent=1)
                os.replace(tmp, man_p)                  # never leave a torn manifest
            with jobs_lock:
                jobs[jid].update(state="done", done=jobs[jid]["total"], added=len(tiles))
        except Exception as e:
            with jobs_lock:
                jobs[jid].update(state="error", error="%s: %s" % (type(e).__name__, e))

    def f_ingest(body, query):
        if not forge:
            return 503, {"error": f"curation code not installed on this host ({FORGE_HOME}/forge.py)"}
        ds = _safe_ds(body.get("dataset"))
        rels = body.get("paths") or []
        if not rels:
            return 400, {"error": "no paths"}
        if len(rels) > 2000:
            return 400, {"error": "too many paths in one request (max 2000)"}
        det_name = _det_name(body.get("detector") or os.environ.get("FORGE_DETECTOR", ""))
        jid = uuid.uuid4().hex[:12]
        with jobs_lock:
            jobs[jid] = {"id": jid, "dataset": ds, "state": "queued", "done": 0, "total": len(rels), "added": 0,
                         "skipped": 0, "started": int(time.time())}
        threading.Thread(target=_ingest, daemon=True, args=(jid, ds, rels, det_name, str(body.get("sam") or DEFAULT_SAM),
                                                            body.get("unseeded", "unlabelled"), float(body.get("conf", 0.15)))).start()
        return 202, {"job": jid}

    def f_job(body, query):
        with jobs_lock:
            j = jobs.get(str(query.get("id", "")))
        return (200, j) if j else (404, {"error": "no such job"})

    def need_trainer():
        if not trainer:
            raise RuntimeError(f"detector trainer not installed on this host ({FORGE_HOME}/trainer.py)")

    def t_options(body, query):
        need_trainer()
        return {"datasets": trainer.list_datasets(), "base_models": trainer.list_base_models(), "gpus": trainer.gpu_inventory()}

    def t_runs(body, query):
        need_trainer(); return {"runs": trainer.list_runs(query.get("dataset") or None)}

    def t_status(body, query):
        need_trainer(); st = trainer.status(query.get("dataset", ""), query.get("run", ""))
        return (200, st) if st else (404, {"error": "no such run"})

    def t_start(body, query):
        need_trainer(); job, err = trainer.start(body or {})
        return (202, job) if job else (400, err)

    def t_stop(body, query):
        need_trainer(); job, err = trainer.stop((body or {}).get("dataset", ""), (body or {}).get("run", ""))
        return (200, job) if job else (400, err)

    def t_install(body, query):
        need_trainer(); ok, err = trainer.install((body or {}).get("dataset", ""), (body or {}).get("run", ""), (body or {}).get("filename", ""))
        return (200, ok) if ok else (400, err)

    for method, path, fn in [("GET", "/forge/health", f_health), ("POST", "/forge/segment", f_segment), ("POST", "/forge/detect", f_detect),
                             ("POST", "/forge/ingest", f_ingest), ("GET", "/forge/job", f_job),
                             ("GET", "/forge/train/options", t_options), ("GET", "/forge/train/runs", t_runs),
                             ("GET", "/forge/train/status", t_status), ("POST", "/forge/train", t_start),
                             ("POST", "/forge/train/stop", t_stop), ("POST", "/forge/train/install", t_install)]:
        api.add_route(method, path, fn)
    api.log(f"forge plugin ready: /forge/* (curation {'on' if forge and trainer else 'OFF'}); kinds detector+sam from plugins/detect.py")
