#!/usr/bin/env python3
"""Make every UNQUANTIZED tensor in a llmcompressor output bit-identical to the BF16 source.

Why: llmcompressor 0.13 converts Qwen3.5-family (1+w) RMSNorms to offset form and back
("Restoring N norm modules to offset convention"); in bf16 that round trip rounds each weight to
the bf16 grid around 1.0 (+-0.0039), i.e. up to ~5% error on norms averaging 0.09. Measured
2026-10-18 on Qwen3.8-27B-Uncensored. Quantized (weight_packed/scale/shape) tensors are untouched.

usage: restore_unquantized.py <out_dir> <src_dir>
"""
import json, os, sys
from safetensors import safe_open
from safetensors.torch import load_file, save_file

out, src = sys.argv[1], sys.argv[2]
si = json.load(open(os.path.join(src, "model.safetensors.index.json")))["weight_map"]
oi = json.load(open(os.path.join(out, "model.safetensors.index.json")))["weight_map"]
shards = sorted({v for k, v in oi.items() if not k.startswith("mtp.")})
total = changed = 0
for sh in shards:
    p = os.path.join(out, sh)
    with safe_open(p, "pt") as f:
        meta = f.metadata()
    t = load_file(p)
    n_changed = 0
    for k in list(t):
        if k not in si:
            continue                      # quantized tensor (weight_packed/...) or non-source key
        with safe_open(os.path.join(src, si[k]), "pt") as f:
            s = f.get_tensor(k)
        if s.shape != t[k].shape:
            raise SystemExit(f"shape mismatch {k}: {tuple(s.shape)} vs {tuple(t[k].shape)}")
        total += 1
        if s.dtype != t[k].dtype or not (s == t[k]).all():
            t[k] = s.contiguous(); n_changed += 1
    changed += n_changed
    print(f"{sh}: {n_changed} tensors restored", flush=True)
    if n_changed:
        tmp = p + ".tmp"
        save_file(t, tmp, metadata=meta)
        os.replace(tmp, p)
    del t
print(f"DONE: {changed}/{total} unquantized tensors differed and were restored", flush=True)
