#!/usr/bin/env python3
"""Estimate the cost of Q8_0 -> W8A16(g128) double rounding, on STOCK weights where truth exists.

  e_single = RTN_g128(W)        - W     (what quantize_38_uncensored does to a BF16 source)
  e_double = RTN_g128(Q8_0(W))  - W     (what a GGUF-sourced W8A16 carries: Q8_0 then g128)
  e_q8     = Q8_0(W)            - W     (the GGUF alone)
Q8_0(W) = the unsloth Q8_K_XL GGUF's stored values, run back through gguf2hf.
RTN_g128 = symmetric int8, per-row groups of 128, scale = absmax/127 (llmcompressor minmax).
"""
import json, os, sys, torch
sys.path.insert(0, "/root/gguf2hf")
import gguf
from gguf2hf_qwen35 import load_template, hf_to_gguf_name, dequant, invert
from safetensors import safe_open

S = "/models/Qwen3.8/27B/BF16-Safetensors"
cfg, tc, idx, shapes = load_template(S)
gt = {t.name: t for t in gguf.GGUFReader("/models/Qwen3.8/27B/GGUF/Q8_K_XL/Qwen3.8-27B-UD-Q8_K_XL.gguf").tensors}


def rtn_g128(w):
    r, c = w.shape
    g = w.reshape(r, c // 128, 128)
    s = (g.abs().amax(-1, keepdim=True) / 127).clamp_min(1e-12)
    return (torch.round(g / s).clamp(-127, 127) * s).reshape(r, c)


def rms(x):
    return float(x.pow(2).mean().sqrt())


names = ["model.language_model.layers.%d.%s" % (l, n) for l, n in [
    (0, "mlp.down_proj.weight"), (10, "mlp.up_proj.weight"), (20, "linear_attn.in_proj_qkv.weight"),
    (31, "self_attn.o_proj.weight"), (40, "linear_attn.out_proj.weight"), (63, "mlp.gate_proj.weight")]]
print(f"{'tensor':55s} {'rms W':>9s} {'e_q8':>9s} {'e_single':>9s} {'e_double':>9s} {'dbl/sgl':>7s}")
tot = []
for hf in names:
    g, k = hf_to_gguf_name(hf, tc["num_hidden_layers"])
    with safe_open(os.path.join(S, idx[hf]), "pt") as f:
        w = f.get_tensor(hf).float()
    q8 = invert(dequant(gt[g]), k, tc).to(torch.bfloat16).float()
    es, ed, eq = rtn_g128(w) - w, rtn_g128(q8) - w, q8 - w
    tot.append(rms(ed) / rms(es))
    print(f"{hf.replace('model.language_model.', ''):55s} {rms(w):9.3e} {rms(eq):9.3e} {rms(es):9.3e} {rms(ed):9.3e} {rms(ed)/rms(es):7.3f}")
print(f"mean double/single RMS error ratio: {sum(tot)/len(tot):.3f}  (sqrt(2)=1.414 if independent and equal)")
