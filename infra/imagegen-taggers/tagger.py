#!/usr/bin/env python3
"""imagegen-tagger — caption a folder of images into <image>.txt sidecars.

Engines (auto-detected from the model dir):
  - WD family (SmilingWolf wd-*-tagger-v3 / wd-v1-4-*): has selected_tags.csv
    (or a single *.csv with tag_id,name,category). Booru tags, 448px, BGR.
  - JoyTag: has top_tags.txt. Booru tags, 448px, CLIP-normalised RGB, sigmoid.
  - BLIP: --kind blip (natural-language caption; handled by blip_caption.py).

ONNX runs on CPU by default or CUDA via --device cuda. Writes "<stem>.txt"
(comma-joined tags). Skips images that already have a caption unless --overwrite.
Emits one JSON progress line per image on stderr when --json is set.
"""
import argparse
import csv
import json
import os
import sys

# Pin CUDA's device numbering to PCI/nvidia-smi order. Without this CUDA uses
# FASTEST_FIRST, where index 4 is a 5060 Ti and the 4090 is index 0 -- so --gpu-index
# silently selects a different card than the one the caller named. Must precede the
# torch / onnxruntime import: the ordering is read when CUDA initialises.
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")


import numpy as np
from PIL import Image

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


def log(obj):
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


def list_images(folder):
    return sorted(n for n in os.listdir(folder)
                  if not n.startswith(".") and not n.startswith("_collage")
                  and os.path.splitext(n)[1].lower() in IMG_EXT)


def pad_square(im, bg):
    w, h = im.size
    m = max(w, h)
    if w == h:
        return im
    canvas = Image.new("RGB", (m, m), bg)
    canvas.paste(im, ((m - w) // 2, (m - h) // 2))
    return canvas


# ---------------- WD family ----------------
def load_wd_tags(model_dir):
    csv_path = os.path.join(model_dir, "selected_tags.csv")
    if not os.path.exists(csv_path):
        cands = [f for f in os.listdir(model_dir) if f.endswith(".csv")]
        if not cands:
            raise SystemExit("no tag csv in model dir")
        csv_path = os.path.join(model_dir, cands[0])
    names, cats = [], []
    with open(csv_path, newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            names.append(row.get("name") or row.get("tag") or "")
            try:
                cats.append(int(row.get("category", 0)))
            except (TypeError, ValueError):
                cats.append(0)
    return names, cats


def wd_preprocess(path, size, nhwc):
    im = Image.open(path).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    im = Image.alpha_composite(bg, im).convert("RGB")
    im = pad_square(im, (255, 255, 255)).resize((size, size), Image.BICUBIC)
    arr = np.asarray(im, dtype=np.float32)          # RGB, HWC, 0-255
    arr = arr[:, :, ::-1]                            # -> BGR
    arr = np.ascontiguousarray(arr)
    if not nhwc:                                     # NCHW
        arr = arr.transpose(2, 0, 1)
    return arr[None]


# ---------------- JoyTag ----------------
_CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
_CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)


def joytag_preprocess(path, size, nhwc):
    im = Image.open(path).convert("RGB")
    im = pad_square(im, (255, 255, 255)).resize((size, size), Image.BICUBIC)
    arr = np.asarray(im, dtype=np.float32) / 255.0
    arr = (arr - _CLIP_MEAN) / _CLIP_STD             # RGB, HWC
    arr = np.ascontiguousarray(arr, dtype=np.float32)
    if not nhwc:
        arr = arr.transpose(2, 0, 1)
    return arr[None]


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", required=True)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    ap.add_argument("--gpu-index", type=int, default=0)
    ap.add_argument("--threshold", type=float, default=0.35)         # general
    ap.add_argument("--char-threshold", type=float, default=0.85)    # character (WD)
    ap.add_argument("--trigger", default="")                          # prepended tag(s)
    ap.add_argument("--spaces", action="store_true")                  # underscores -> spaces
    ap.add_argument("--max-tags", type=int, default=0)                # 0 = no cap
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--files", default="")   # comma-separated names within --folder; empty = whole folder
    ap.add_argument("--threads", type=int, default=8)   # bound CPU use on the shared host
    ap.add_argument("--caption-ext", default="txt")     # sidecar ext (tags=txt, NL=caption)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    import onnxruntime as ort
    onnx = os.path.join(a.model_dir, "model.onnx")
    if not os.path.exists(onnx):
        cands = [f for f in os.listdir(a.model_dir) if f.endswith(".onnx")]
        if not cands:
            raise SystemExit("no model.onnx in model dir")
        onnx = os.path.join(a.model_dir, cands[0])

    if a.device == "cuda":
        provs = [("CUDAExecutionProvider", {"device_id": a.gpu_index}), "CPUExecutionProvider"]
    else:
        provs = ["CPUExecutionProvider"]
    so = ort.SessionOptions()
    if a.threads > 0:                      # bound CPU + silence LXC affinity warnings
        so.intra_op_num_threads = a.threads
        so.inter_op_num_threads = 1
    sess = ort.InferenceSession(onnx, sess_options=so, providers=provs)
    used = sess.get_providers()[0]
    inp = sess.get_inputs()[0]
    out_name = sess.get_outputs()[0].name
    # determine layout + size from input shape (dim==3 is channels)
    shp = [d if isinstance(d, int) else -1 for d in inp.shape]
    nhwc = (len(shp) == 4 and shp[3] == 3)
    size = shp[1] if nhwc else (shp[2] if len(shp) == 4 else 448)
    if size <= 0:
        size = 448

    is_joytag = os.path.exists(os.path.join(a.model_dir, "top_tags.txt"))
    if is_joytag:
        with open(os.path.join(a.model_dir, "top_tags.txt")) as f:
            names = [ln.strip() for ln in f if ln.strip()]
        cats = [0] * len(names)
        pre = joytag_preprocess
    else:
        names, cats = load_wd_tags(a.model_dir)
        pre = wd_preprocess

    imgs = list_images(a.folder)
    if a.files:
        _want = {n.strip() for n in a.files.split(",") if n.strip()}
        imgs = [n for n in imgs if n in _want]
    total = len(imgs)
    log({"event": "start", "total": total, "engine": "joytag" if is_joytag else "wd",
         "model": os.path.basename(a.model_dir), "provider": used, "size": size})
    done = wrote = skipped = errs = 0
    for nm in imgs:
        done += 1
        stem = os.path.splitext(nm)[0]
        txt = os.path.join(a.folder, stem + "." + a.caption_ext)
        if os.path.exists(txt) and not a.overwrite:
            skipped += 1
            if a.json:
                log({"event": "img", "done": done, "total": total, "file": nm, "status": "skip"})
            continue
        try:
            x = pre(os.path.join(a.folder, nm), size, nhwc)
            preds = sess.run([out_name], {inp.name: x})[0][0]
            preds = np.asarray(preds, dtype=np.float32)
            if preds.min() < 0.0 or preds.max() > 1.0:   # logits -> probs
                preds = sigmoid(preds)
            picked = []
            for i, p in enumerate(preds):
                if i >= len(names):
                    break
                c = cats[i]
                if c == 9:                                # rating tag — skip
                    continue
                thr = a.char_threshold if c == 4 else a.threshold
                if p >= thr:
                    picked.append((names[i], float(p)))
            picked.sort(key=lambda t: t[1], reverse=True)
            if a.max_tags > 0:
                picked = picked[:a.max_tags]
            tags = [t[0] for t in picked]
            if a.spaces:
                tags = [t.replace("_", " ") for t in tags]
            if a.trigger:
                trig = [t.strip() for t in a.trigger.split(",") if t.strip()]
                tags = trig + tags
            with open(txt, "w") as f:
                f.write(", ".join(tags))
            try: os.chmod(txt, 0o664)
            except Exception: pass
            wrote += 1
            if a.json:
                log({"event": "img", "done": done, "total": total, "file": nm,
                     "status": "ok", "ntags": len(tags)})
        except Exception as e:
            errs += 1
            log({"event": "img", "done": done, "total": total, "file": nm,
                 "status": "error", "error": str(e)[:200]})
    log({"event": "done", "total": total, "wrote": wrote, "skipped": skipped, "errors": errs})
    print(json.dumps({"ok": True, "total": total, "wrote": wrote, "skipped": skipped, "errors": errs}))


if __name__ == "__main__":
    main()
