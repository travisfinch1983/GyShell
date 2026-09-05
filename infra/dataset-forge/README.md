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

## Reviewing

**AI-Lab -> AI · Image Gen -> Dataset Review.** Put the dataset under
`/imagegen/_datasets/<name>/{manifest.json,tiles,overlays}` (that path is
`/ai-assets/imagegen/_datasets/<name>` from the AI-Lab backend — same files, no transfer,
which is why forge can run on ai-epyc for the GPU while the UI reads from CT152).

`A` approves, `R` rejects, arrows move, decisions POST immediately. Only tiles carrying a
mask need a verdict; negatives are already valid backgrounds and export as empty labels, so
the API refuses to "approve" one. `export` skips anything marked `rejected`.

## Adding more images — especially ones the detector FAILS on

    # explicit list of images, merged into the existing dataset
    $P forge.py scan --corpus / --out /imagegen/_datasets/panties/manifest.json \
        --paths-from misses.txt --append

    # unseeded tiles are HELD, not called background
    $P forge.py annotate --manifest /imagegen/_datasets/panties/manifest.json \
        --detector <seed.pt> --device 3 --append --unseeded unlabelled \
        --tiles /imagegen/_datasets/panties/tiles --overlays .../overlays

**The trap this avoids.** Masks are seeded by the existing detector, so on an image it FAILS
on there are no seeds. Under the default `--unseeded negative` those tiles would be exported
as empty labels — asserting the target is background, which is precisely the mistake we are
training to fix. `--unseeded unlabelled` holds them out of export until a human labels them.

Note the pipeline cannot tell "the detector missed it" from "this tile genuinely has none" —
in a 4-tile split of a full-body render the head-and-shoulders tile really is empty. Only a
human can resolve that, which is what click-to-annotate is for.

`--append` never overwrites `approved` / `rejected` / `manual`, and a re-run that finds
nothing leaves an existing tile alone (otherwise a settled `negative` silently becomes
`unlabelled` just because a later run used a different `--unseeded`).

## Click-to-annotate (samd)

`samd.py` is a small SAM point-prompt service, run by **`forge-samd.service` on ai-epyc**
(`systemctl status forge-samd`), listening on :8791. The AI-Lab backend proxies to it from
CT152, since SAM needs the GPU and the backend has none.

In Dataset Review: **click the target** to get a polygon, shift+click to subtract, `S` saves.
Saved masks are marked `manual` so `--append` will not overwrite them.

The ViT encode is ~all of SAM's cost, so the encoder output is cached per tile: measured
**1.99 s for the first click on a tile, 0.099 s for the next** — 20x, and the difference
between usable and unusable.

## Adding images from the UI

**AI · Image Gen -> Training Images -> select -> "Add to dataset…"**. Pick an existing
dataset or create one; the job runs on ai-epyc and the modal polls it to completion.

The selection is sent as paths RELATIVE to the imagegen root, so the same request resolves
on either host (`/ai-assets/imagegen` on CT152, `/imagegen` on ai-epyc) with no absolute
paths crossing the wire. Images are NOT copied — forge tiles them and records the SOURCE
path, so a dataset stays a view over the corpus.

`samd` grew `/ingest` (returns a job id) and `/job/<id>`. It imports `annotate_images()` and
`merge_tiles()` from `forge.py` rather than reimplementing them, so the UI and the CLI cannot
drift into producing different datasets. New images default to `--unseeded unlabelled` from
the UI: the whole reason to add images by hand is that the detector fails on them.

## Iterating: seed with the new model, TRAIN from stock weights

Two different decisions, with different answers.

**Seeding** — point `annotate` / the UI at the newest model. v4 seeds at 92% where the
stock detector managed 66%, so there is less to correct, and every tile it CANNOT mask
arrives as `unlabelled` — a direct readout of where the model is still blind. That list is
the shopping list for the next round of images.

  🛑 But a seed is a LABOUR-SAVING DEVICE, NOT GROUND TRUTH. Seeding with the model that
  will be trained on the result is self-training: approve a slightly-wrong mask and the
  error is baked in and amplified next round. Seeds from our own model deserve MORE
  scrutiny than the stock model's, not less — the review step is the only thing preventing
  the drift.

**Training** — keep starting from the stock `yolo11s-seg.pt`, NOT from the previous model:

  * the run is 9 minutes on 411 tiles, so fine-tuning saves nothing worth having
  * fine-tuning compounds whatever bias the previous model had; starting from generic
    weights lets the accumulated HUMAN labels speak for themselves
  * `v5 = yolo11s-seg + dataset@N` is reproducible. `v5 = v4 + more data` makes every
    future model depend on the exact history of every previous run, and a mistake three
    rounds back can never be undone without redoing all of them
  * repeated fine-tuning on a growing set drifts toward the most recent additions

The dataset is the artefact worth accumulating. The models are disposable rebuilds of it.

**Existing verdicts are safe.** `--append` never overwrites `approved` / `rejected` /
`manual`, and a re-run that finds nothing leaves a tile alone — so re-seeding can only
add masks to tiles nobody has judged yet.

## The frozen benchmark, and why selection bias is the trap

Using the current model to pick which images to add is good for finding blind spots and
BAD for measuring progress. Three contamination channels, only two of which "train from
stock weights" closes:

  1. WEIGHT inheritance — closed by training from stock yolo11s-seg.pt each round.
  2. LABEL contamination — closed by DRAWING masks rather than approving the model's own
     seeds. Only as closed as the review is real: a slightly-off mask looks fine at
     thumbnail size.
  3. SELECTION bias — NOT closed by either. If images are added only where the current
     model fails, the dataset grows enriched in hard cases and depleted of easy ones,
     drifting from the distribution actually generated, and the model can get worse at the
     common cases it stopped seeing.

Selection bias also destroys the ability to COMPARE versions: a pool re-drawn each round
from "what the current model misses" gets harder every round, so v5 can beat v4 and score
lower. A benchmark selected by the model under test measures the selector.

So: `holdout.txt` — 80 images sampled ONCE at random from the labelled-positive corpus,
never trained on. `samd`'s /ingest refuses any path in it (the job reports `heldout: N`),
so the set cannot be quietly absorbed into training, and compare.py REFUSES TO RUN if any
held-out image has reached the dataset rather than silently reporting a score measured on
training data.

Mitigation for (3) while still targeting gaps: add a random sample alongside the targeted
images each round, so the easy cases keep their share.

**Baseline on the frozen set (2026-09-05), conf 0.25, 4 tiles, imgsz 640:**

    stock Panty-detailer-3b   40/80   50%
    Panties-v4 (ours)         75/80   94%      +35 found, 0 lost

That is the number every later version is measured against.

## Two frozen benchmarks — and why one was not enough

The first holdout was built by scanning `outputs/comfyui` for prompt-matched PNGs, which
STRUCTURALLY EXCLUDED photos: 80/80 generated, 0 photos, while the training set was 265
photos to 134 renders. So "96% on the frozen set" described the MINORITY style and said
nothing about the majority — and a per-style breakdown returned a single row, because the
benchmark could only see one style.

    holdout.txt          80 generated renders   (prompt-verified positives)
    holdout_photos.txt   80 real photographs    (TAGGER-verified: wd-eva02 says panties /
                                                 underwear; 147 of 173 sampled qualified,
                                                 sampled across ~40 folders so it is not one
                                                 photographer's set)

Photos carry no prompt, so folder names were not trusted — candidates were staged, tagged,
selected by tag, and the staging copies deleted rather than littering .txt through the photo
library.

Score them SEPARATELY; never average them:

    HOLDOUT=/imagegen/_datasets/panties/holdout.txt        $P compare.py <weights>
    HOLDOUT=/imagegen/_datasets/panties/holdout_photos.txt $P compare.py <weights>

samd's /ingest now refuses every `holdout*.txt`, not just the first — a second frozen set the
ingest did not know about could be absorbed into training silently, which is the exact
failure the frozen set exists to prevent. Verified: an ingest of a photo-holdout path returns
`heldout: 1, added: 0`.

## Should styles get separate detectors?

Not on the evidence so far, and the question is not yet answerable — it needs the per-style
numbers above. Against splitting: it divides the LABELS, which are the bottleneck (1184 tiles
over three styles is ~400 each, back to the weaker v4 size, while training costs 22 minutes);
the mixed model shows no sign of suffering from mixing; and three detectors need a style
classifier at inference, a new component and a new failure mode. If one style does lag, the
first move is more data for it — split only if that fails to close the gap.
