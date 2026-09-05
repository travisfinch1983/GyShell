#!/usr/bin/env python3
"""Old detector vs the newly trained one, on HELD-OUT source images.

The honest comparison: images that are in neither the training nor the validation split, at
the resolution and tiling the ComfyUI pipeline actually uses (768x1536 -> four 768x768 tiles
-> imgsz 640). Val mAP measures the model against its own labels; this measures what the
user will see.
"""
import json, os, sys, warnings, random
warnings.filterwarnings("ignore")
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
from ultralytics import YOLO
from PIL import Image

OLD = "/imagegen/ultralytics/segm/Panty-detailer-3b-(segm)-(y8)-(segment).pt"
NEW = sys.argv[1] if len(sys.argv) > 1 else "/imagegen/_datasets/panties/runs/v1/weights/best.pt"
DEV = int(os.environ.get("DEV", "4"))
CONF = float(os.environ.get("CONF", "0.25"))
YS = (0, 256, 512, 768)

# Which frozen set to score against. holdout.txt is generated renders; holdout_photos.txt is
# tagger-verified real photos. They MUST be reported separately — the first benchmark was
# 80/80 generated, so "96%" described the minority style and said nothing about the majority.
HOLD = os.environ.get("HOLDOUT", "/imagegen/_datasets/panties/holdout.txt")
pool = [l.strip() for l in open(HOLD) if l.strip()]
man = json.load(open("/imagegen/_datasets/panties/manifest.json"))
used = {i["path"] for i in man["items"]}
leaked = [p for p in pool if p in used]
if leaked:
    sys.exit("TEST SET LEAK: %d held-out images are in the dataset — the score would be "
             "measured on training data.\n  %s" % (len(leaked), leaked[0]))
print("frozen held-out set: %d images (fixed across versions, never trained on)\n" % len(pool))

def fires(model, im):
    for y in YS:
        if y + 768 > im.height: break
        r = model.predict(im.crop((0, y, 768, y + 768)), imgsz=640, conf=CONF,
                          verbose=False, device=DEV)[0]
        if r.boxes is not None and len(r.boxes):
            return True
    return False

old, new = YOLO(OLD), YOLO(NEW)
o = n = both = 0
for p in pool:
    im = Image.open(p).convert("RGB")
    im = im.resize((768, int(im.height * 768 / im.width)), Image.LANCZOS)
    a, b = fires(old, im), fires(new, im)
    o += a; n += b; both += (a and b)
N = len(pool)
print("at conf=%.2f, 4 tiles, imgsz 640" % CONF)
print("  OLD Panty-detailer-3b : %2d/%d  (%.0f%%)" % (o, N, 100*o/N))
print("  NEW %-21s: %2d/%d  (%.0f%%)" % (os.path.basename(os.path.dirname(os.path.dirname(NEW))), n, N, 100*n/N))
print("  found by both         : %2d" % both)
print("  NEW found, OLD missed : %2d" % (n - both))
print("  OLD found, NEW missed : %2d" % (o - both))
