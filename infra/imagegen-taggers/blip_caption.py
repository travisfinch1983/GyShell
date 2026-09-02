#!/usr/bin/env python3
"""imagegen BLIP captioner — natural-language captions into <image>.txt sidecars
(for Flux-style training). Runs under the photo-upscale venv (torch cu128 +
transformers already present). GPU by default (point --gpu-index at the 4090).

Model: HF Salesforce/blip-image-captioning-large (the local LAVIS .pth isn't
HF-loadable). First run downloads + caches into --model-dir for offline reuse.
Same sidecar/skip/overwrite/trigger semantics as the ONNX tagger.
"""
import argparse
import json
import os
import sys

# Pin CUDA's device numbering to PCI/nvidia-smi order. Without this CUDA uses
# FASTEST_FIRST, where index 4 is a 5060 Ti and the 4090 is index 0 -- so --gpu-index
# silently selects a different card than the one the caller named. Must precede the
# torch / onnxruntime import: the ordering is read when CUDA initialises.
os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")


IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


def log(o):
    sys.stderr.write(json.dumps(o) + "\n"); sys.stderr.flush()


def list_images(folder):
    return sorted(n for n in os.listdir(folder)
                  if not n.startswith(".") and not n.startswith("_collage")
                  and os.path.splitext(n)[1].lower() in IMG_EXT)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", required=True)
    ap.add_argument("--model-id", default="Salesforce/blip-image-captioning-large")
    ap.add_argument("--model-dir", default="/imagegen/blip/hf-large")  # local cache (shared mount)
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    ap.add_argument("--gpu-index", type=int, default=0)
    ap.add_argument("--prompt", default="")            # optional conditional prefix
    ap.add_argument("--max-new-tokens", type=int, default=50)
    ap.add_argument("--min-new-tokens", type=int, default=8)
    ap.add_argument("--trigger", default="")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--files", default="")   # comma-separated names within --folder; empty = whole folder
    ap.add_argument("--caption-ext", default="caption")   # NL captions default to .caption (co-exist with .txt tags)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    import torch
    from PIL import Image
    from transformers import BlipProcessor, BlipForConditionalGeneration

    dev = f"cuda:{a.gpu_index}" if (a.device == "cuda" and torch.cuda.is_available()) else "cpu"
    dtype = torch.float16 if dev.startswith("cuda") else torch.float32

    # load from local cache dir if populated, else download from the hub + persist
    src = a.model_dir if os.path.exists(os.path.join(a.model_dir, "config.json")) else a.model_id
    proc = BlipProcessor.from_pretrained(src)
    model = BlipForConditionalGeneration.from_pretrained(src, torch_dtype=dtype).to(dev).eval()
    if src == a.model_id:                              # just downloaded — cache for next time
        try:
            os.makedirs(a.model_dir, exist_ok=True)
            proc.save_pretrained(a.model_dir); model.save_pretrained(a.model_dir)
        except Exception as e:
            log({"event": "warn", "msg": f"cache save failed: {e}"})

    imgs = list_images(a.folder)
    if a.files:
        _want = {n.strip() for n in a.files.split(",") if n.strip()}
        imgs = [n for n in imgs if n in _want]
    total = len(imgs)
    log({"event": "start", "total": total, "engine": "blip", "device": dev,
         "model": os.path.basename(a.model_dir)})
    done = wrote = skipped = errs = 0
    for nm in imgs:
        done += 1
        stem = os.path.splitext(nm)[0]
        txt = os.path.join(a.folder, stem + "." + a.caption_ext)
        if os.path.exists(txt) and not a.overwrite:
            skipped += 1
            if a.json: log({"event": "img", "done": done, "total": total, "file": nm, "status": "skip"})
            continue
        try:
            im = Image.open(os.path.join(a.folder, nm)).convert("RGB")
            if a.prompt:
                inputs = proc(im, a.prompt, return_tensors="pt").to(dev, dtype)
            else:
                inputs = proc(im, return_tensors="pt").to(dev, dtype)
            with torch.no_grad():
                out = model.generate(**inputs, max_new_tokens=a.max_new_tokens,
                                     min_new_tokens=a.min_new_tokens, num_beams=3, repetition_penalty=1.2)
            cap = proc.decode(out[0], skip_special_tokens=True).strip()
            if a.prompt and cap.lower().startswith(a.prompt.lower()):
                cap = cap[len(a.prompt):].strip()
            # strip BLIP's filler lead-ins so captions read as clean descriptions
            for pre in ("there is ", "there are ", "this is ", "a picture of ",
                        "an image of ", "a photo of ", "a photography of "):
                if cap.lower().startswith(pre):
                    cap = cap[len(pre):]
                    break
            cap = cap.strip()
            if a.trigger:
                cap = f"{a.trigger.strip().rstrip(',')}, {cap}"
            with open(txt, "w") as f:
                f.write(cap)
            try: os.chmod(txt, 0o664)
            except Exception: pass
            wrote += 1
            if a.json: log({"event": "img", "done": done, "total": total, "file": nm,
                            "status": "ok", "chars": len(cap)})
        except Exception as e:
            errs += 1
            log({"event": "img", "done": done, "total": total, "file": nm,
                 "status": "error", "error": str(e)[:200]})
    log({"event": "done", "total": total, "wrote": wrote, "skipped": skipped, "errors": errs})
    print(json.dumps({"ok": True, "total": total, "wrote": wrote, "skipped": skipped, "errors": errs}))


if __name__ == "__main__":
    main()
