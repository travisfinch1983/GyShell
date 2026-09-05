#!/usr/bin/env python3
"""dataset-forge — build a YOLO-segmentation dataset from an existing image corpus.

WHY THIS SHAPE
  Inference will run as 4 overlapping 768x768 tiles (measured 44/70 vs 20/70 untiled), so the
  DATASET IS TILES TOO. Train and inference then see the target at the same scale, and tiles
  with no target become correctly-balanced negatives for free instead of being curated by hand.

  Seed boxes come from the existing detector run tiled (~63% recall on labelled positives).
  SAM turns each box into a tight polygon. That bootstraps ~2/3 of the corpus cheaply; the
  point is not that the seed detector is good, it is that a model trained on THIS corpus's
  style and framing should beat it — the seeds only have to be RIGHT, not COMPLETE.

  Every auto-annotation is provisional until reviewed. `annotate` writes overlays precisely so
  the seeds can be rejected before they poison the labels.

SUBCOMMANDS
  scan      corpus -> manifest of candidates (prompt-matched, size-filtered)
  annotate  manifest -> tiles + SAM polygons + review overlays
  export    reviewed manifest -> YOLO-seg dataset (images/labels/data.yaml)
  stats     summarise a manifest
"""
import argparse, json, os, re, struct, sys, zlib, random, hashlib

TILE = 768


# ── corpus scanning ─────────────────────────────────────────────────────────
def png_size(p):
    with open(p, "rb") as f:
        if f.read(8) != b"\x89PNG\r\n\x1a\n":
            return None
        f.seek(16)
        b = f.read(8)
    return struct.unpack(">II", b) if len(b) == 8 else None


def png_text(p):
    """Prompt metadata, without decoding pixels."""
    out = []
    with open(p, "rb") as f:
        if f.read(8) != b"\x89PNG\r\n\x1a\n":
            return ""
        while True:
            h = f.read(8)
            if len(h) < 8:
                break
            ln, typ = struct.unpack(">I4s", h)
            data = f.read(ln)
            f.read(4)
            if typ in (b"tEXt", b"iTXt"):
                out.append(data.decode("utf-8", "replace"))
            elif typ == b"zTXt":
                try:
                    _, rest = data.split(b"\x00", 1)
                    out.append(zlib.decompress(rest[1:]).decode("utf-8", "replace"))
                except Exception:
                    pass
            if typ == b"IDAT":       # metadata all precedes the pixel data
                break
    return " ".join(out)


def cmd_scan(a):
    if a.paths_from:
        # Explicit list: the caller already knows these are wanted (e.g. "images the current
        # detector fails on"), so the prompt filter would only get in the way.
        items = []
        for line in open(a.paths_from):
            p = line.strip()
            if not p or not os.path.exists(p):
                continue
            wh = png_size(p) or (0, 0)
            items.append({"path": p, "w": wh[0], "h": wh[1]})
        _finish(a, items)
        return
    inc = re.compile("|".join(r"\b%s\b" % re.escape(t) for t in a.terms), re.I)
    exc = re.compile("|".join(r"\b%s\b" % re.escape(t) for t in a.exclude), re.I) if a.exclude else None
    items, seen_hash = [], set()
    for root, _, fs in os.walk(a.corpus):
        for f in sorted(fs):
            if not f.lower().endswith(".png"):
                continue
            p = os.path.join(root, f)
            try:
                wh = png_size(p)
            except Exception:
                continue
            if not wh:
                continue
            w, h = wh
            if w < a.min_width or h < a.min_height:
                continue
            blob = png_text(p)
            if not inc.search(blob):
                continue
            if exc and exc.search(blob):
                continue
            # de-dup by content head: pre/post-detailer pairs are near-identical framings
            with open(p, "rb") as fh:
                sig = hashlib.sha1(fh.read(65536)).hexdigest()
            if sig in seen_hash:
                continue
            seen_hash.add(sig)
            items.append({"path": p, "w": w, "h": h})
            if a.limit and len(items) >= a.limit:
                break
        if a.limit and len(items) >= a.limit:
            break
    _finish(a, items)


def _finish(a, items):
    if a.append and os.path.exists(a.out):
        man = json.load(open(a.out))
        have = {i["path"] for i in man.get("items", [])}
        fresh = [i for i in items if i["path"] not in have]
        man["items"] = (man.get("items") or []) + fresh
        man["terms"] = sorted(set((man.get("terms") or []) + a.terms))
        json.dump(man, open(a.out, "w"), indent=1)
        print("scanned -> %d new candidates appended (%d already present); %d total"
              % (len(fresh), len(items) - len(fresh), len(man["items"])))
    else:
        json.dump({"terms": a.terms, "items": items}, open(a.out, "w"), indent=1)
        print("scanned -> %d candidates written to %s" % (len(items), a.out))


# ── annotation ──────────────────────────────────────────────────────────────
def _iou(a, b):
    """IoU of two (x, y, w, h) rects."""
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union else 0.0


def tile_origins(h, tile=TILE, n=4):
    """n tile tops spread over the image height, last one flush with the bottom."""
    if h <= tile:
        return [0]
    step = (h - tile) / (n - 1)
    return sorted({int(round(i * step)) for i in range(n)})


def annotate_images(items, det, pred, tiles_dir, overlays_dir, *, width=768, imgsz=640,
                    conf=0.15, device=4, min_area=400, simplify=0.004, unseeded="negative",
                    progress=None):
    """Tile + seed + SAM-refine a list of {"path": ...} records.

    Shared by the CLI (`annotate`) and by samd's /ingest job, so the UI and the command line
    cannot drift into producing different datasets — the same lesson the rename preview taught.
    Returns the list of tile records.
    """
    import numpy as np, cv2, torch
    from PIL import Image
    os.makedirs(tiles_dir, exist_ok=True)
    os.makedirs(overlays_dir, exist_ok=True)
    out = []
    for idx, it in enumerate(items):
        try:
            im = Image.open(it["path"]).convert("RGB")
        except Exception as e:
            print("  skip %s (%s)" % (it["path"], e)); continue
        if im.width != width:
            im = im.resize((width, int(im.height * width / im.width)), Image.LANCZOS)
        stem = os.path.splitext(os.path.basename(it["path"]))[0][:60]
        for ti, y in enumerate(tile_origins(im.height)):
            tile = im.crop((0, y, TILE, y + TILE))
            arr = np.array(tile)
            r = det.predict(tile, imgsz=imgsz, conf=conf, verbose=False, device=device)[0]
            polys = []
            if r.boxes is not None and len(r.boxes):
                pred.set_image(arr)
                boxes = r.boxes.xyxy.cpu().numpy()
                tb = torch.tensor(boxes, device=pred.device)
                tb = pred.transform.apply_boxes_torch(tb, arr.shape[:2])
                masks, scores, _ = pred.predict_torch(point_coords=None, point_labels=None,
                                                      boxes=tb, multimask_output=False)
                for m, sc in zip(masks.cpu().numpy(), scores.cpu().numpy()):
                    mm = (m[0] * 255).astype("uint8")
                    cnts, _ = cv2.findContours(mm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    if not cnts:
                        continue
                    c = max(cnts, key=cv2.contourArea)
                    if cv2.contourArea(c) < min_area:
                        continue
                    c = cv2.approxPolyDP(c, simplify * cv2.arcLength(c, True), True).reshape(-1, 2)
                    if len(c) < 3:
                        continue
                    cand = {"pts": [[round(float(x) / TILE, 6), round(float(yy) / TILE, 6)]
                                    for x, yy in c],
                            "sam_score": round(float(sc[0]), 4),
                            "_box": [float(v) for v in cv2.boundingRect(c)]}
                    if not any(_iou(cand["_box"], q["_box"]) > 0.85 for q in polys):
                        polys.append(cand)
            name = "%s_t%d.png" % (re.sub(r"[^A-Za-z0-9_.-]", "_", stem), ti)
            tile.save(os.path.join(tiles_dir, name))
            for q in polys: q.pop("_box", None)
            out.append({"tile": name, "src": it["path"], "y": y, "polys": polys,
                        "status": "auto" if polys else unseeded})
            if polys:
                ov = arr.copy()
                for p in polys:
                    pts = np.array([[int(x * TILE), int(yy * TILE)] for x, yy in p["pts"]], np.int32)
                    cv2.polylines(ov, [pts], True, (0, 255, 0), 3)
                    layer = ov.copy(); cv2.fillPoly(layer, [pts], (0, 255, 0))
                    ov = cv2.addWeighted(layer, 0.25, ov, 0.75, 0)
                Image.fromarray(ov).save(os.path.join(overlays_dir, name))
        if progress:
            progress(idx + 1, len(items))
    return out


def merge_tiles(man, out, append):
    """Merge fresh tile records into a manifest. See --append in the CLI for the rules."""
    if not append:
        man["tiles"] = out
        return man
    prior = {t["tile"]: t for t in man.get("tiles", [])}
    for r in out:
        old_rec = prior.get(r["tile"])
        if old_rec is not None:
            if old_rec["status"] in ("approved", "rejected", "manual"):
                continue
            if not r["polys"]:
                continue
        prior[r["tile"]] = r
    man["tiles"] = list(prior.values())
    return man


def cmd_annotate(a):
    os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
    import warnings; warnings.filterwarnings("ignore")
    from segment_anything import sam_model_registry, SamPredictor
    from ultralytics import YOLO

    man = json.load(open(a.manifest))
    det = YOLO(a.detector)
    sam_type = "vit_h" if "vit_h" in a.sam else ("vit_l" if "vit_l" in a.sam else "vit_b")
    # SAM-HQ checkpoints carry extra decoder tensors (hf_token, compress_vit_feat, ...) that the
    # vanilla segment_anything package refuses. HQ needs the segment_anything_hq fork; say so
    # rather than surfacing a 25-line state_dict dump.
    if "_hq_" in os.path.basename(a.sam):
        try:
            from segment_anything_hq import sam_model_registry as hq_registry
            sam = hq_registry[sam_type](checkpoint=a.sam).to(f"cuda:{a.device}")
        except ImportError:
            sys.exit("%s is a SAM-HQ checkpoint and segment_anything_hq is not installed.\n"
                     "Use --sam /imagegen/sam/sam_vit_h_4b8939.pth, or pip install segment-anything-hq."
                     % a.sam)
    else:
        sam = sam_model_registry[sam_type](checkpoint=a.sam).to(f"cuda:{a.device}")
    pred = SamPredictor(sam)

    out = annotate_images(man["items"], det, pred, a.tiles, a.overlays, width=a.width,
                          imgsz=a.imgsz, conf=a.conf, device=a.device, min_area=a.min_area,
                          simplify=a.simplify, unseeded=a.unseeded,
                          progress=lambda n, t: (print("  %d/%d source images" % (n, t), flush=True)
                                                 if n % 25 == 0 else None))
    man = merge_tiles(man, out, a.append)
    json.dump(man, open(a.manifest, "w"), indent=1)
    pos = sum(1 for r in out if r["polys"])
    print("annotated: %d tiles, %d with a mask, %d without%s"
          % (len(out), pos, len(out) - pos, "  (merged into existing manifest)" if a.append else ""))


# ── export ──────────────────────────────────────────────────────────────────
def cmd_export(a):
    import shutil
    man = json.load(open(a.manifest))
    # `unlabelled` = "we do not know what is in here". Exporting it as an empty label would
    # assert it is background, which is a lie the model would learn.
    SKIP = {"rejected", "unlabelled"}
    tiles = [t for t in man.get("tiles", []) if t["status"] not in SKIP]
    held = sum(1 for t in man.get("tiles", []) if t["status"] == "unlabelled")
    if held:
        print("  holding back %d unlabelled tile(s) — annotate or clear them first" % held)
    if not tiles:
        sys.exit("no tiles — run annotate first")
    # split by SOURCE image so near-identical tiles cannot straddle train/val
    srcs = sorted({t["src"] for t in tiles})
    random.Random(a.seed).shuffle(srcs)
    n_val = max(1, int(len(srcs) * a.val_frac))
    val = set(srcs[:n_val])
    counts = {"train": [0, 0], "val": [0, 0]}
    for split in ("train", "val"):
        for sub in ("images", "labels"):
            os.makedirs(os.path.join(a.out, split, sub), exist_ok=True)
    for t in tiles:
        split = "val" if t["src"] in val else "train"
        shutil.copy2(os.path.join(a.tiles, t["tile"]), os.path.join(a.out, split, "images", t["tile"]))
        lab = os.path.join(a.out, split, "labels", os.path.splitext(t["tile"])[0] + ".txt")
        # A tile marked `negative` exports an EMPTY label whatever polygons it still carries.
        # Otherwise a seed mask the reviewer REJECTED as "not the target" would be written
        # out as ground truth — teaching the model precisely the mistake it was rejected for.
        polys = [] if t["status"] == "negative" else t["polys"]
        with open(lab, "w") as f:                        # empty file = a real negative, not a skip
            for p in polys:
                flat = " ".join("%.6f %.6f" % (x, y) for x, y in p["pts"])
                f.write("0 %s\n" % flat)
        counts[split][0] += 1
        counts[split][1] += 1 if polys else 0
    yaml = ("path: %s\ntrain: train/images\nval: val/images\n\nnames:\n  0: %s\n"
            % (os.path.abspath(a.out), a.cls))
    open(os.path.join(a.out, "data.yaml"), "w").write(yaml)
    for s in ("train", "val"):
        n, p = counts[s]
        print("  %-5s %4d tiles  (%d positive / %d negative)" % (s, n, p, n - p))
    print("data.yaml -> %s/data.yaml" % a.out)


def cmd_stats(a):
    man = json.load(open(a.manifest))
    tiles = man.get("tiles", [])
    st = {}
    for t in tiles:
        st[t["status"]] = st.get(t["status"], 0) + 1
    print("source images : %d" % len(man.get("items", [])))
    print("tiles         : %d" % len(tiles))
    for k, v in sorted(st.items()):
        print("  %-9s %d" % (k, v))
    n = sum(len(t["polys"]) for t in tiles)
    print("polygons      : %d" % n)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)

    s = sp.add_parser("scan");      s.set_defaults(fn=cmd_scan)
    s.add_argument("--corpus", required=True); s.add_argument("--out", required=True)
    s.add_argument("--terms", nargs="+", default=[]); s.add_argument("--exclude", nargs="*", default=[])
    s.add_argument("--min-width", type=int, default=0); s.add_argument("--min-height", type=int, default=0)
    s.add_argument("--limit", type=int, default=0)
    s.add_argument("--append", action="store_true", help="add to an existing manifest instead of replacing it")
    s.add_argument("--paths-from", help="file of image paths, one per line — bypasses the corpus walk")

    a_ = sp.add_parser("annotate"); a_.set_defaults(fn=cmd_annotate)
    a_.add_argument("--manifest", required=True); a_.add_argument("--detector", required=True)
    a_.add_argument("--sam", default="/imagegen/sam/sam_vit_h_4b8939.pth")
    a_.add_argument("--tiles", required=True); a_.add_argument("--overlays", required=True)
    a_.add_argument("--width", type=int, default=768); a_.add_argument("--imgsz", type=int, default=640)
    a_.add_argument("--conf", type=float, default=0.15); a_.add_argument("--device", type=int, default=4)
    a_.add_argument("--append", action="store_true", help="merge into an existing manifest instead of replacing it")
    a_.add_argument("--unseeded", choices=["negative","unlabelled"], default="negative",
                    help="status for a tile with no seed detection")
    a_.add_argument("--min-area", type=float, default=400); a_.add_argument("--simplify", type=float, default=0.004)

    e = sp.add_parser("export");    e.set_defaults(fn=cmd_export)
    e.add_argument("--manifest", required=True); e.add_argument("--tiles", required=True)
    e.add_argument("--out", required=True); e.add_argument("--cls", default="target")
    e.add_argument("--val-frac", type=float, default=0.15); e.add_argument("--seed", type=int, default=0)

    t = sp.add_parser("stats");     t.set_defaults(fn=cmd_stats)
    t.add_argument("--manifest", required=True)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
