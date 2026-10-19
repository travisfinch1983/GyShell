#!/usr/bin/env python3
"""Validate gguf2hf_qwen35 by round-tripping a STOCK GGUF against the stock HF weights.

For every text/MTP tensor: invert the GGUF tensor and compare with the stock BF16 tensor.
  - GGUF-stored BF16/F32 tensors must match (near-)exactly;
  - Q8_0 tensors must show 8-bit rounding error only: per-32-block max|err| <= blockmax/127
    (+bf16 slack) and cosine ~1.
A transform bug (wrong reorder, missing -1, wrong axis) shows up as error orders of magnitude
above that bound.  usage: validate_roundtrip.py <stock.gguf> <stock_hf_dir>
"""
import collections, re, sys
import torch
sys.path.insert(0, "/root/gguf2hf")
import gguf
from gguf2hf_qwen35 import load_template, hf_to_gguf_name, dequant, invert
from safetensors import safe_open
import os

src, tdir = sys.argv[1:3]
cfg, tc, idx, shapes = load_template(tdir)
n_layers = tc["num_hidden_layers"]
gt = {t.name: t for t in gguf.GGUFReader(src).tensors}
stats = collections.defaultdict(list); fails = []
for hf in sorted(idx):
    g, kind = hf_to_gguf_name(hf, n_layers)
    if g is None:
        continue
    t = gt[g]
    x = invert(dequant(t), kind, tc).to(torch.bfloat16).float()
    with safe_open(os.path.join(tdir, idx[hf]), "pt") as fh:
        ref = fh.get_tensor(hf).float()
    if x.shape != ref.shape:
        fails.append((hf, f"shape {tuple(x.shape)} vs {tuple(ref.shape)}")); continue
    err = (x - ref).abs()
    typ = t.tensor_type.name
    key = (re.sub(r"\d+", "N", hf.replace("model.language_model.", "")), typ)
    rel = float(err.max() / ref.abs().max().clamp_min(1e-12))
    cos = float(torch.nn.functional.cosine_similarity(x.flatten().double(), ref.flatten().double(), 0))
    if typ == "Q8_0" and ref.dim() == 2 and ref.shape[-1] % 32 == 0:
        bm = ref.reshape(ref.shape[0], -1, 32).abs().amax(-1, keepdim=True)
        be = err.reshape(ref.shape[0], -1, 32).amax(-1, keepdim=True)
        # Q8_0 stores scale = blockmax/127 as fp16; below fp16's normal range (6.1e-5, i.e.
        # blockmax < ~7.8e-3) the scale itself is subnormal and loses relative precision, so a
        # near-zero block can show a large RELATIVE error with a tiny absolute one (measured:
        # worst 0.67 at blockmax 4.5e-6, abs err 3e-6). That is the GGUF's own rounding, not a
        # converter bug: exempt those blocks from the ratio but bound their absolute error.
        normal = bm >= 127 * 6.104e-5
        ratio = float((be / bm.clamp_min(1e-12))[normal].max()) if normal.any() else 0.0
        sub_abs = float(be[~normal].max()) if (~normal).any() else 0.0
        ok = ratio <= 1 / 127 * 1.6 + 0.008 and sub_abs <= 1e-4 and cos > 0.9999
    else:
        ratio = float("nan")
        ok = rel <= 1e-2 and cos > 0.99999
    stats[key].append((rel, float(err.mean()), cos, ratio))
    if not ok:
        fails.append((hf, f"{typ} rel={rel:.3g} cos={cos:.6f} blockratio={ratio:.4g}"))
print(f"{'tensor kind':58s} {'type':5s} {'n':>3s} {'max rel':>9s} {'mean abs':>9s} {'min cos':>9s} {'blk err/max':>11s}")
for (k, typ), v in sorted(stats.items()):
    print(f"{k:58s} {typ:5s} {len(v):3d} {max(a[0] for a in v):9.2e} {max(a[1] for a in v):9.2e} "
          f"{min(a[2] for a in v):9.6f} {max(a[3] for a in v):11.4g}")
print(f"\nFAILURES: {len(fails)}")
for f in fails[:30]:
    print("  ", *f)
print("VALIDATION", "PASS" if not fails else "FAIL")
