#!/usr/bin/env python3
"""One-off repair (2026-10-16) for two civitai-downloader bugs fixed in the same commit:

1. Sidecars (.civit.info, .civit.full.info, .json, .metadata.json) and example images went to
   checkpoints/<family>/ while a DiT-family model's weights went to diffusion-models/<family>/.
   -> move each such set next to its weights.
2. The Filename box was seeded from the FIRST file of the version, which on some repos is the VAE
   or text encoder, so model + encoder + VAE (and the sidecars) were all named after it.
   -> rename those sets (weights in diffusion-models/text-encoders/vae, plus sidecars/images),
      and update fileNameOverride in civitai-history.json so the downloader still finds them.

  civitai-fix-meta-placement.py [--apply]
"""
import json
import os
import re
import shutil
import sys

ROOT = "/imagegen"
HIST = "/opt/ai-lab/.gybackend-data/civitai-history.json"
APPLY = "--apply" in sys.argv
RENAMES = {  # family, old base -> new base, CivitAI versionId (for the history entry)
    ("Anima", "V3.0_-_Unity.Qwen_image_vae"): ("Terra_Rising_Unity-v3.0", "3201465"),
    ("Anima", "V4.0.Qwen_image_vae"): ("One_Obsession_Anima-v4.0", "3301424"),
    ("Anima", "WaiANIMA_v10Base10_txt"): ("WAI-ANIMA", "2983680"),
}
WEIGHTS = (".safetensors", ".gguf", ".ckpt")


def set_files(d, base):
    """Sidecars + example images of one set (exact base, never a longer name sharing the prefix)."""
    pat = re.compile(re.escape(base) + r"(?:_\d+)?\.(?:jpeg|jpg|png|webp|mp4)$|" +
                     re.escape(base) + r"\.(?:civit\.info|civit\.full\.info|json|metadata\.json)$")
    return sorted(f for f in os.listdir(d) if pat.fullmatch(f))


def mv(src, dst):
    if os.path.exists(dst):
        print(f"   ! exists, skipped: {dst}")
        return False
    print(f"   {'mv' if APPLY else 'would mv'} {os.path.relpath(src, ROOT)} -> {os.path.relpath(dst, ROOT)}")
    if APPLY:
        shutil.move(src, dst)
    return True


def main():
    hist_changes = {}
    # ── 2. renames first (so step 1 moves the renamed sidecars) ──
    for (fam, old), (new, vid) in RENAMES.items():
        print(f"RENAME {fam}: {old} -> {new}")
        for top in ("diffusion-models", "text-encoders", "vae"):
            d = os.path.join(ROOT, top, fam)
            for ext in WEIGHTS:
                p = os.path.join(d, old + ext)
                if os.path.exists(p):
                    mv(p, os.path.join(d, new + ext))
        d = os.path.join(ROOT, "checkpoints", fam)
        for f in set_files(d, old):
            mv(os.path.join(d, f), os.path.join(d, new + f[len(old):]))
        hist_changes[vid] = new

    # ── 1. relocate stranded sidecar sets ──
    for fam in sorted(os.listdir(os.path.join(ROOT, "checkpoints"))):
        cd, dd = os.path.join(ROOT, "checkpoints", fam), os.path.join(ROOT, "diffusion-models", fam)
        if not (os.path.isdir(cd) and os.path.isdir(dd)):
            continue
        for info in sorted(f for f in os.listdir(cd) if f.endswith(".civit.info")):
            base = info[: -len(".civit.info")]
            if APPLY is False and (fam, base) in RENAMES:   # dry run: would already be renamed
                continue
            here = [f for f in os.listdir(cd) if f.endswith(WEIGHTS) and (f.startswith(base + ".") or re.match(re.escape(base) + r"[-_]", f))]
            if here:
                continue
            there = [f for f in os.listdir(dd) if f.endswith(WEIGHTS) and (f.startswith(base + ".") or re.match(re.escape(base) + r"[-_]", f))]
            if not there:
                continue
            print(f"RELOCATE {fam}/{base}  (weights: {', '.join(there[:3])})")
            for f in set_files(cd, base):
                mv(os.path.join(cd, f), os.path.join(dd, f))

    # ── history ──
    if hist_changes:
        h = json.load(open(HIST))
        n = 0
        for e in h.get("items", []):
            v = str(e.get("versionId"))
            if v in hist_changes:
                print(f"HISTORY {v}: fileNameOverride {e.get('fileNameOverride')!r} -> {hist_changes[v]!r}")
                e["fileNameOverride"] = hist_changes[v]
                n += 1
        if APPLY and n:
            shutil.copy2(HIST, HIST + ".bak-fixmeta")
            tmp = HIST + ".tmp"
            with open(tmp, "w") as f:
                json.dump(h, f, indent=2)
            os.replace(tmp, HIST)
            print(f"history: {n} entr{'y' if n == 1 else 'ies'} updated (backup {HIST}.bak-fixmeta)")


if __name__ == "__main__":
    main()
