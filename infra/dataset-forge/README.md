# dataset-forge

Builds a YOLO-segmentation dataset from an existing image corpus, for training a focused
detector when an off-the-shelf one does not generalise.

**Runs on ai-epyc (10.0.0.234)** — it needs the GPU, ultralytics and `segment_anything`, all of
which live in the ComfyUI conda env: `/opt/conda/envs/comfyui/bin/python`.
Deployed copy: `/opt/dataset-forge/forge.py`.

## Why tiles, not whole images

Inference runs as 4 overlapping 768x768 tiles — measured **44/70 vs 20/70 untiled** on 70
prompt-labelled positives, because Ultralytics letterboxes the long side to 640 and a
768x1536 frame spends half its input on padding. The dataset is therefore tiles too, so
training and inference see the target at the same scale. Tiles with no target become
correctly-balanced negatives for free.

## Pipeline

    P=/opt/conda/envs/comfyui/bin/python

    # 1. candidates — prompt metadata read from the PNG, no pixels decoded
    $P forge.py scan --corpus /imagegen/outputs/comfyui --out panties.manifest.json \
        --terms panties panty thong --min-width 700 --min-height 1200

    # 2. seed boxes from the existing detector -> SAM -> polygons + review overlays
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True $P forge.py annotate \
        --manifest panties.manifest.json --device 2 \
        --detector "/imagegen/ultralytics/segm/Panty-detailer-3b-(segm)-(y8)-(segment).pt" \
        --tiles tiles --overlays overlays

    # 3. REVIEW overlays/ and set  status:"rejected"  on any bad tile in the manifest
    $P forge.py stats --manifest panties.manifest.json

    # 4. YOLO-seg dataset
    $P forge.py export --manifest panties.manifest.json --tiles tiles \
        --out ds-panties --cls panties

    # 5. train
    CUDA_DEVICE_ORDER=PCI_BUS_ID $P -m ultralytics.cfg segment train \
        model=yolo11s-seg.pt data=ds-panties/data.yaml epochs=100 imgsz=640 batch=8 device=4

## Notes that cost time to learn

- **`--device` is in PCI_BUS_ID order** (the script exports it): 0-3 are the 5060 Tis, 4 is the
  4090. The 4090 is usually occupied by ComfyUI — SAM vit_h needs ~6 GB, so a 5060 Ti is
  normally the right choice, not the "best" card.
- **SAM-HQ checkpoints do not load in the vanilla `segment_anything` package** (extra
  `hf_token` / `compress_vit_feat` decoder tensors). Use `sam_vit_h_4b8939.pth`, or install
  `segment-anything-hq`. The script detects `_hq_` in the filename and says so.
- **SAM is encoded once per TILE, not per box** — the ViT encode is ~all of the cost.
- Overlapping seed boxes make SAM emit the same region twice; polygons are de-duplicated at
  IoU > 0.85, otherwise ultralytics logs "duplicate labels removed" and silently drops one.
- **The train/val split is by SOURCE IMAGE**, never by tile — 4 tiles of one render are near
  identical, and splitting by tile would leak val into train and inflate the metrics.
- An empty `.txt` label is a real negative to YOLO ("background"), not a skipped file.

## Status

Verified end to end on 25 source images: 85 tiles / 41 masked / 44 negatives, exported, and
trained by ultralytics with **0 corrupt, 38 backgrounds recognised, 0 duplicate labels**.
The 3-epoch smoke run's metrics are meaningless and were only a format check.

Not yet built: a review UI. Today, rejecting a bad auto-annotation means editing `status` in
the manifest by hand.
