#!/usr/bin/env python3
"""Scan every Civitai-downloaded model/LoRA under /imagegen, remove duplicate example images and
backfill each set to the downloader's imageCount (default 10).

Why: until ai-lab 9bf17b3d the downloader de-duplicated model-card vs gallery images by URL, but
Civitai serves the same image under different URLs in the two lists, so showcase images were saved
twice and the set came up short of real examples.

Per set (a `<base>.civit.info` sidecar; images are <base>.<ext> and <base>_<N>.<ext>):
  1. exact duplicates (same MD5) are MOVED to /imagegen/_delete/civitai-dupes-<date>/<rel path>,
     keeping the lowest-numbered copy;
  2. if fewer than imageCount remain, the downloader's own selection
     (GET /api/civitai/preview-images?versionId=…, model card first + gallery fill, de-duplicated by
     image UUID) is walked from position <have> onward; each candidate is downloaded, skipped if
     its MD5 is already in the set, else written into the lowest free index slot.
Nothing else is renamed, so index 0 (the cover) stays put.

  civitai-images-backfill.py [--apply] [--limit N] [--root DIR ...]
Without --apply it only reports. Progress + a summary go to stdout.
"""
import argparse
import collections
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.request

API = "http://127.0.0.1:17890/api/civitai"
ROOT = "/imagegen"
DEFAULT_DIRS = ["loras", "checkpoints", "diffusion-models", "embeddings", "vae", "text-encoders", "dora", "controlnet", "upscale-models"]
EXTS = ("jpeg", "jpg", "png", "webp", "mp4")
UA = {"User-Agent": "Mozilla/5.0 (ai-lab civitai backfill)"}
DUPES = os.path.join(ROOT, "_delete", "civitai-dupes-" + time.strftime("%Y%m%d"))


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def local_images(base):
    """{index: path} for <base>.<ext> (0) and <base>_<N>.<ext>."""
    d, stem = os.path.dirname(base), os.path.basename(base)
    out = {}
    pat = re.compile(re.escape(stem) + r"(?:_(\d+))?\.(" + "|".join(EXTS) + r")$")
    for name in os.listdir(d):
        m = pat.fullmatch(name)
        if m:
            i = int(m.group(1) or 0)
            out.setdefault(i, os.path.join(d, name))   # two exts at one index: keep the first seen
    return out


def get_json(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.load(r)


def fetch(url, timeout=120):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def owner_of(path):
    st = os.stat(path)
    return st.st_uid, st.st_gid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="stop after N sets that need work")
    ap.add_argument("--root", nargs="*", default=DEFAULT_DIRS)
    ap.add_argument("--pace", type=float, default=0.6, help="seconds between Civitai calls")
    a = ap.parse_args()

    cfg = get_json(f"{API}/config")
    cfg = cfg.get("config", cfg)
    want = int(cfg.get("imageCount") or 10)
    print(f"mode={'APPLY' if a.apply else 'dry-run'} imageCount={want} source={cfg.get('imageSource')}", flush=True)

    stats = collections.Counter()
    worked = 0
    for top in a.root:
        for dirpath, _dirs, files in os.walk(os.path.join(ROOT, top)):
            if "/_delete" in dirpath or "/OLD" in dirpath:
                continue
            for fn in sorted(files):
                if not fn.endswith(".civit.info"):
                    continue
                base = os.path.join(dirpath, fn[: -len(".civit.info")])
                stats["sets"] += 1
                try:
                    vid = json.load(open(base + ".civit.info")).get("id")
                except Exception as e:
                    print(f"  ! unreadable {base}.civit.info: {e}", flush=True)
                    stats["unreadable"] += 1
                    continue
                imgs = local_images(base)
                # 1. duplicates
                seen, dupes = {}, []
                for i in sorted(imgs):
                    h = md5(imgs[i])
                    if h in seen:
                        dupes.append(i)
                    else:
                        seen[h] = i
                have = len(imgs) - len(dupes)
                need = max(0, want - have)
                if not dupes and not need:
                    continue
                if need and not vid:
                    stats["no_version_id"] += 1
                rel = os.path.relpath(base, ROOT)
                stats["sets_with_dupes"] += bool(dupes)
                stats["dupe_files"] += len(dupes)
                stats["sets_short"] += bool(need)
                stats["images_needed"] += need
                worked += 1
                print(f"{rel}: {len(imgs)} images, {len(dupes)} duplicate(s), need {need}", flush=True)
                if not a.apply:
                    if a.limit and worked >= a.limit:
                        break
                    continue
                # Match the set's existing images (usually 100000:100000, written from an
                # unprivileged CT); the directory itself is often root-owned.
                owners = collections.Counter(owner_of(p) for p in imgs.values())
                uid, gid = owners.most_common(1)[0][0] if owners else owner_of(dirpath)
                for i in dupes:
                    src = imgs.pop(i)
                    dst = os.path.join(DUPES, os.path.relpath(src, ROOT))
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.move(src, dst)
                    stats["moved"] += 1
                # 2. backfill
                if need and vid:
                    time.sleep(a.pace)
                    try:
                        sel = get_json(f"{API}/preview-images?versionId={vid}")
                    except Exception as e:
                        print(f"  ! preview-images {vid}: {e}", flush=True)
                        stats["api_errors"] += 1
                        continue
                    cands = sel.get("images") or []
                    hashes = set(seen)
                    added = 0
                    for c in cands[have:] + cands[:have]:   # likely-new ones first; the prefix is usually already here
                        if added >= need:
                            break
                        try:
                            data = fetch(c["url"])
                        except Exception as e:
                            print(f"  ! {c['url'][:90]}: {e}", flush=True)
                            stats["img_errors"] += 1
                            continue
                        h = hashlib.md5(data).hexdigest()
                        if h in hashes:
                            continue
                        slot = next(i for i in range(10_000) if i not in imgs)
                        ext = "mp4" if c.get("type") == "video" else "jpeg"
                        path = f"{base}.{ext}" if slot == 0 else f"{base}_{slot}.{ext}"
                        tmp = path + ".part"
                        with open(tmp, "wb") as f:
                            f.write(data)
                        os.replace(tmp, path)
                        try:
                            os.chown(path, uid, gid)
                        except PermissionError:
                            pass
                        imgs[slot] = path
                        hashes.add(h)
                        added += 1
                        stats["added"] += 1
                    if added < need:
                        stats["still_short"] += 1
                    print(f"  + added {added}/{need}", flush=True)
                if a.limit and worked >= a.limit:
                    break
            if a.limit and worked >= a.limit:
                break
    print("SUMMARY " + json.dumps(dict(stats), sort_keys=True), flush=True)


if __name__ == "__main__":
    sys.exit(main())
