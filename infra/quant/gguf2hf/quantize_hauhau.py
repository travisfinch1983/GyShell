#!/usr/bin/env python3
"""[HauhauCS variant: MODEL is the gguf2hf dequantized dir; MTP grafted from its mtp.* tensors]
Quantize Qwen3.8-27B-Uncensored (JonathanColetti, Heretic) BF16 -> compressed-tensors W8A16
INT8, laid out exactly like the production quant /models/Qwen3.8/27B-INT8-W8A16-MTP that 1Cat
1.5.0 serves on 1cat-vllm-5003 (2026-10-18).

Differences from quantize_38.py (2026-08-15, 1Cat 1.0.0 era):
  * IGNORE mirrors production: only GDN in_proj_a / in_proj_b stay BF16. 1Cat 1.5.0 loads a
    quantized in_proj_qkv / in_proj_z / out_proj (production proves it). The August
    "whole linear_attn.* must stay BF16" rule was a 1.0.0 loader limitation.
  * MTP: transformers drops mtp.* on load, so the 15 BF16 tensors are grafted back from the
    source's model-mtp.safetensors as model_mtp.safetensors + index entries (production layout).
    Unlike August's hand-extracted head, these are the ORIGINAL file bytes; acceptance still has
    to be measured before trusting it (production uses DFlash, not MTP, anyway).

RTN, no calibration, CPU only. Save to LOCAL disk (CIFS serialization dies silently).
"""
import json, os, shutil, sys, time

import torch
import transformers
from transformers import AutoConfig
from compressed_tensors.quantization import (
    QuantizationArgs, QuantizationScheme, QuantizationStrategy, QuantizationType,
)
from llmcompressor import oneshot
from llmcompressor.modifiers.quantization import QuantizationModifier

MODEL = "/root/hauhau-bf16"        # gguf2hf_qwen35.py output (dequantized HauhauCS Q8_K_P)
STOCK = "/models/Qwen3.8/27B/BF16-Safetensors"      # for preprocessor files the abliteration dropped
PROD = "/models/Qwen3.8/27B-INT8-W8A16-MTP"
OUT = "/root/hauhau-w8a16"

IGNORE = [
    "lm_head",
    "re:.*visual.*",
    "re:^mtp.*",
    "re:.*linear_attn[.]in_proj_a$",
    "re:.*linear_attn[.]in_proj_b$",
]


def main():
    t0 = time.time()
    cfg = AutoConfig.from_pretrained(MODEL)
    arch = cfg.architectures[0]
    print(f"[1/6] architecture: {arch}", flush=True)
    cls = getattr(transformers, arch)
    print("[2/6] loading BF16 weights on CPU...", flush=True)
    model = cls.from_pretrained(MODEL, dtype=torch.bfloat16, device_map="cpu")
    print(f"      loaded in {time.time()-t0:.0f}s", flush=True)

    scheme = QuantizationScheme(
        targets=["Linear"],
        weights=QuantizationArgs(
            num_bits=8, type=QuantizationType.INT, symmetric=True,
            strategy=QuantizationStrategy.GROUP, group_size=128, observer="minmax",
        ),
        input_activations=None, output_activations=None,
    )
    recipe = QuantizationModifier(config_groups={"group_0": scheme}, ignore=IGNORE)
    print("[3/6] quantizing (RTN)...", flush=True)
    oneshot(model=model, recipe=recipe, output_dir=OUT)
    print(f"      quantized+saved in {time.time()-t0:.0f}s", flush=True)

    print("[4/6] side files", flush=True)
    for src_dir in (MODEL, STOCK):
        for fn in os.listdir(src_dir):
            if fn.endswith(".safetensors") or fn in ("model.safetensors.index.json", "config.json"):
                continue
            src, dst = os.path.join(src_dir, fn), os.path.join(OUT, fn)
            if os.path.isfile(src) and not os.path.exists(dst):
                shutil.copy2(src, dst); print(f"      + {fn}  (from {os.path.basename(os.path.dirname(src_dir))})", flush=True)

    print("[5/6] grafting BF16 MTP head (from the dequantized dir's mtp.* tensors)", flush=True)
    from safetensors import safe_open
    from safetensors.torch import save_file
    src_idx = json.load(open(os.path.join(MODEL, "model.safetensors.index.json")))["weight_map"]
    mtp = sorted(k for k in src_idx if k.startswith("mtp."))
    tensors = {}
    for k in mtp:
        with safe_open(os.path.join(MODEL, src_idx[k]), "pt") as f:
            tensors[k] = f.get_tensor(k)
    save_file(tensors, os.path.join(OUT, "model_mtp.safetensors"), metadata={"format": "pt"})
    ip = os.path.join(OUT, "model.safetensors.index.json")
    idx = json.load(open(ip))
    for k in mtp:
        idx["weight_map"][k] = "model_mtp.safetensors"
    json.dump(idx, open(ip, "w"), indent=2)
    print(f"      {len(mtp)} mtp tensors indexed", flush=True)

    print("[6/6] verify against production layout", flush=True)
    ks = set(idx["weight_map"])
    pk = set(json.load(open(os.path.join(PROD, "model.safetensors.index.json")))["weight_map"])
    print(f"      tensors: ours {len(ks)}  production {len(pk)}")
    print(f"      only ours: {sorted(ks - pk)[:8]}")
    print(f"      only prod: {sorted(pk - ks)[:8]}")
    ok = ks == pk and len(mtp) == 15
    print(f"      VERDICT: {'PASS - identical tensor layout to production' if ok else 'FAIL'}")
    print(f"DONE in {time.time()-t0:.0f}s -> {OUT}", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
