#!/usr/bin/env python3
"""GGUF (llama.cpp `qwen35` arch) -> HF Qwen3_5ForConditionalGeneration BF16 safetensors.

Built 2026-10-18 to bring GGUF-only releases (HauhauCS abliterations) to 1Cat-vLLM as W8A16.
Inverts llama.cpp's converter (conversion/qwen.py: _LinearAttentionVReorderBase -> Qwen3NextModel
-> TextModel tensor map) exactly as of llama.cpp 010be9683 (unchanged for qwen35 since 4df29be4f):

  forward (HF -> GGUF), in order                 inverse applied here (GGUF -> HF)
  V-head reorder grouped->tiled (num_k != num_v)  tiled->grouped on the same axes:
     in_proj_qkv V rows / in_proj_z rows /          (same tensors, same head dims)
     in_proj_a,b rows / A_log, dt_bias /
     conv1d V channels / out_proj columns
  A_log -> -exp(A_log)  (= ssm_a)                 A_log = log(-ssm_a)
  dt_bias -> dt_proj.bias (= ssm_dt.bias)         rename back
  conv1d squeeze [C,1,K] -> [C,K]                 unsqueeze(1)
  *norm.weight + 1  (except linear_attn.norm)     - 1   (incl. q_norm/k_norm, mtp enorm/hnorm/
                                                         shared_head.norm, final norm)
  mtp.* -> blk.{n_layers}.* / nextn.*             mapped back to mtp.*

Vision: taken from a template HF dir (stock Qwen3.8-27B) — abliterations are text-only; the
caller should verify the release's mmproj matches (gguf2hf --check-mmproj).
Everything is dequantized to float32 by gguf-py then stored as BF16 (Q8_0 values * fp16 scale
are exactly representable in fp32; the BF16 cast rounds them once more — negligible vs Q8).

usage:
  gguf2hf_qwen35.py <model.gguf> <template_hf_dir> <out_dir> [--check-mmproj <mmproj.gguf>]
  needs PYTHONPATH=<llama.cpp>/gguf-py ; run with the llmc env (torch, safetensors).
"""
import json, os, shutil, sys, time
import numpy as np
import torch
import gguf
from safetensors import safe_open
from safetensors.torch import save_file

SHARD_BYTES = 5 * 1024**3


def load_template(tdir):
    cfg = json.load(open(os.path.join(tdir, "config.json")))
    tc = cfg.get("text_config", cfg)
    idx = json.load(open(os.path.join(tdir, "model.safetensors.index.json")))["weight_map"]
    shapes = {}
    for k, f in idx.items():
        with safe_open(os.path.join(tdir, f), "pt") as fh:
            shapes[k] = tuple(fh.get_slice(k).get_shape())
    return cfg, tc, idx, shapes


def reorder_inverse(t, dim, nk, nvk, hd):
    """Undo llama.cpp _reorder_v_heads: tiled [K0,K1,..,K0,K1..] -> grouped [G0_v0..v{r-1},..]."""
    shape = list(t.shape)
    if dim < 0:
        dim += len(shape)
    t = t.reshape(*shape[:dim], nvk, nk, hd, *shape[dim + 1:])        # tiled layout = (nvk, nk)
    perm = list(range(t.dim())); perm[dim], perm[dim + 1] = perm[dim + 1], perm[dim]
    return t.permute(*perm).contiguous().reshape(*shape)


def hf_to_gguf_name(hf, n_layers):
    """Return (gguf_name, kind) for a text/mtp HF tensor name; kind drives the inverse transform."""
    if hf == "lm_head.weight":
        return "output.weight", "plain"
    p = "model.language_model."
    if hf == p + "embed_tokens.weight":
        return "token_embd.weight", "plain"
    if hf == p + "norm.weight":
        return "output_norm.weight", "norm1"
    mtp_top = {"mtp.fc.weight": ("nextn.eh_proj.weight", "plain"),
               "mtp.pre_fc_norm_embedding.weight": ("nextn.enorm.weight", "norm1"),
               "mtp.pre_fc_norm_hidden.weight": ("nextn.hnorm.weight", "norm1"),
               "mtp.norm.weight": ("nextn.shared_head_norm.weight", "norm1")}
    if hf in mtp_top:
        g, k = mtp_top[hf]
        return f"blk.{n_layers}.{g}", k
    if hf.startswith("mtp.layers."):
        i, rest = hf[len("mtp.layers."):].split(".", 1)
        bid = n_layers + int(i)
    elif hf.startswith(p + "layers."):
        i, rest = hf[len(p + "layers."):].split(".", 1)
        bid = int(i)
    else:
        return None, None
    table = {
        "input_layernorm.weight": ("attn_norm.weight", "norm1"),
        "post_attention_layernorm.weight": ("post_attention_norm.weight", "norm1"),
        "mlp.gate_proj.weight": ("ffn_gate.weight", "plain"),
        "mlp.up_proj.weight": ("ffn_up.weight", "plain"),
        "mlp.down_proj.weight": ("ffn_down.weight", "plain"),
        "self_attn.q_proj.weight": ("attn_q.weight", "plain"),
        "self_attn.k_proj.weight": ("attn_k.weight", "plain"),
        "self_attn.v_proj.weight": ("attn_v.weight", "plain"),
        "self_attn.o_proj.weight": ("attn_output.weight", "plain"),
        "self_attn.q_norm.weight": ("attn_q_norm.weight", "norm1"),
        "self_attn.k_norm.weight": ("attn_k_norm.weight", "norm1"),
        "linear_attn.in_proj_qkv.weight": ("attn_qkv.weight", "qkv"),
        "linear_attn.in_proj_z.weight": ("attn_gate.weight", "rows_v"),
        "linear_attn.in_proj_a.weight": ("ssm_alpha.weight", "rows_1"),
        "linear_attn.in_proj_b.weight": ("ssm_beta.weight", "rows_1"),
        "linear_attn.A_log": ("ssm_a", "alog"),
        "linear_attn.dt_bias": ("ssm_dt.bias", "vec_1"),
        "linear_attn.conv1d.weight": ("ssm_conv1d.weight", "conv"),
        "linear_attn.norm.weight": ("ssm_norm.weight", "plain"),
        "linear_attn.out_proj.weight": ("ssm_out.weight", "cols_v"),
    }
    if rest not in table:
        raise KeyError(f"no GGUF mapping for {hf}")
    g, k = table[rest]
    return f"blk.{bid}.{g}", k


def dequant(t):
    """GGUF tensor -> float32 torch tensor in HF (row-major, reversed-ne) shape.
    Q8_0 takes a vectorized path (block = fp16 scale + 32 int8); gguf-py's generic dequant
    is ~100x slower on 27B. Everything else goes through gguf-py."""
    shape = tuple(int(d) for d in reversed(t.shape))
    if t.tensor_type == gguf.GGMLQuantizationType.Q8_0:
        raw = np.asarray(t.data).view(np.uint8).reshape(-1, 34)
        scale = raw[:, :2].copy().view(np.float16).astype(np.float32)        # (nb, 1)
        q = raw[:, 2:].copy().view(np.int8).astype(np.float32)               # (nb, 32)
        return torch.from_numpy((q * scale).reshape(shape))
    a = gguf.quants.dequantize(t.data, t.tensor_type)
    return torch.from_numpy(np.array(a, dtype=np.float32).reshape(shape))


def invert(x, kind, tc):
    nk, nv = tc["linear_num_key_heads"], tc["linear_num_value_heads"]
    hk, hv = tc["linear_key_head_dim"], tc["linear_value_head_dim"]
    r = nv // nk
    reorder = nk != nv
    if kind == "plain":
        return x
    if kind == "norm1":
        return x - 1.0
    if kind == "qkv":
        if not reorder:
            return x
        qd = hk * nk
        q, k, v = x[:qd], x[qd:2 * qd], x[2 * qd:]
        return torch.cat([q, k, reorder_inverse(v, 0, nk, r, hv)], 0)
    if kind == "rows_v":
        return reorder_inverse(x, 0, nk, r, hv) if reorder else x
    if kind == "rows_1":
        return reorder_inverse(x, 0, nk, r, 1) if reorder else x
    if kind == "cols_v":
        return reorder_inverse(x, 1, nk, r, hv) if reorder else x
    if kind == "vec_1":
        return reorder_inverse(x.unsqueeze(-1), 0, nk, r, 1).squeeze(-1) if reorder else x
    if kind == "alog":
        x = torch.log(-x.double()).float()
        return reorder_inverse(x.unsqueeze(-1), 0, nk, r, 1).squeeze(-1) if reorder else x
    if kind == "conv":                     # gguf [C, K]
        if reorder:
            qk = hk * nk * 2
            x = torch.cat([x[:qk], reorder_inverse(x[qk:], 0, nk, r, hv)], 0)
        return x.unsqueeze(1)              # HF [C, 1, K]
    raise ValueError(kind)


def check_mmproj(mmproj, tdir, idx):
    """Fingerprint-match every mmproj tensor against the template's visual tensors."""
    vis = {k: v for k, v in idx.items() if ".visual." in k or k.startswith("visual.")}
    # fingerprint = 257 order statistics of the value distribution (layout-independent, so
    # reshapes/transposes/conv splits by llama.cpp's mmproj converter don't matter)
    qs = torch.linspace(0, 1, 257, dtype=torch.float64)
    def fp(a):
        s = a.flatten().double().sort().values
        return s[(qs * (s.numel() - 1)).round().long()]
    fps = {}
    for k, f in vis.items():
        with safe_open(os.path.join(tdir, f), "pt") as fh:
            a = fh.get_tensor(k).float()
        fps.setdefault(a.numel(), []).append((k, fp(a)))
    r = gguf.GGUFReader(mmproj)
    ok = bad = 0; worst = []
    g = {t.name: t for t in r.tensors}
    # llama.cpp splits the Conv3d patch embed (temporal_patch_size 2) into .weight / .weight.1
    if "v.patch_embd.weight" in g and "v.patch_embd.weight.1" in g:
        pe = torch.stack([dequant(g["v.patch_embd.weight"]), dequant(g["v.patch_embd.weight.1"])], 2)
        k = next(k for k in vis if "patch_embed" in k and k.endswith("weight"))
        with safe_open(os.path.join(tdir, vis[k]), "pt") as fh:
            ref = fh.get_tensor(k).float()
        d = float((pe - ref).abs().max()) if pe.shape == ref.shape else float("inf")
        ok, bad = (ok + 2, bad) if d <= 1e-2 else (ok, bad + 2)
        if d > 1e-2:
            worst.append(("v.patch_embd (stacked)", d))
    for t in r.tensors:
        if t.name.startswith("v.patch_embd.weight"):
            continue
        a = dequant(t)
        cands = fps.get(a.numel(), [])
        s = fp(a)
        best = min((float((s - c).abs().max()) for _, c in cands), default=float("inf"))
        # mmproj may store some norms with +1 or f32; accept a constant 1.0 offset too
        best1 = min((float((s - 1.0 - c).abs().max()) for _, c in cands), default=float("inf"))
        m = min(best, best1)
        if m <= 1e-2:
            ok += 1
        else:
            bad += 1; worst.append((t.name, m))
    print(f"mmproj check: {ok} tensors match a template visual tensor, {bad} do not", flush=True)
    for n, m in worst[:10]:
        print(f"   MISMATCH {n}: best max|diff| {m:.4g}", flush=True)
    return bad == 0


def main():
    a = sys.argv[1:]
    mmproj = None
    if "--check-mmproj" in a:
        i = a.index("--check-mmproj"); mmproj = a[i + 1]; del a[i:i + 2]
    src, tdir, out = a
    t0 = time.time()
    cfg, tc, idx, shapes = load_template(tdir)
    n_layers = tc["num_hidden_layers"]
    if mmproj and not check_mmproj(mmproj, tdir, idx):
        raise SystemExit("mmproj differs from template vision tower - map it back instead of copying")
    r = gguf.GGUFReader(src)
    gt = {t.name: t for t in r.tensors}
    os.makedirs(out, exist_ok=True)
    used = set(); shard = {}; nbytes = 0; shards = []; wm = {}

    def flush():
        nonlocal shard, nbytes
        if not shard:
            return
        fn = f"model-{len(shards) + 1:05d}.safetensors"
        save_file(shard, os.path.join(out, fn), metadata={"format": "pt"})
        for k in shard:
            wm[k] = fn
        shards.append(fn); shard = {}; nbytes = 0
        print(f"  wrote {fn} ({len(wm)} tensors, {time.time() - t0:.0f}s)", flush=True)

    for hf in sorted(idx):
        g, kind = hf_to_gguf_name(hf, n_layers)
        if g is None:                                   # vision -> from template
            with safe_open(os.path.join(tdir, idx[hf]), "pt") as fh:
                x = fh.get_tensor(hf).to(torch.bfloat16)
        else:
            if g not in gt:
                raise SystemExit(f"GGUF lacks {g} (for {hf})")
            x = invert(dequant(gt[g]), kind, tc).to(torch.bfloat16)
            used.add(g)
        if tuple(x.shape) != shapes[hf]:
            raise SystemExit(f"shape mismatch {hf}: got {tuple(x.shape)} want {shapes[hf]}")
        shard[hf] = x.contiguous(); nbytes += x.numel() * 2
        if nbytes >= SHARD_BYTES:
            flush()
    flush()
    unused = sorted(set(gt) - used)
    if unused:
        print(f"WARNING: {len(unused)} GGUF tensors unused: {unused[:10]}", flush=True)
    total = sum(os.path.getsize(os.path.join(out, s)) for s in shards)
    json.dump({"metadata": {"total_size": total}, "weight_map": wm},
              open(os.path.join(out, "model.safetensors.index.json"), "w"), indent=2)
    for fn in os.listdir(tdir):
        if fn.endswith(".safetensors") or fn == "model.safetensors.index.json":
            continue
        p = os.path.join(tdir, fn)
        if os.path.isfile(p):
            shutil.copy2(p, os.path.join(out, fn))
    # carry the GGUF's own chat template if it differs from the template dir's
    ct = r.fields.get("tokenizer.chat_template")
    if ct is not None:
        tmpl = bytes(ct.parts[ct.data[0]]).decode("utf-8")
        cur = open(os.path.join(out, "chat_template.jinja")).read() if os.path.exists(os.path.join(out, "chat_template.jinja")) else None
        if tmpl != cur:
            open(os.path.join(out, "chat_template.jinja"), "w").write(tmpl)
            print("  chat_template.jinja: GGUF template DIFFERS from template dir - wrote the GGUF's", flush=True)
        else:
            print("  chat_template.jinja: identical to template dir", flush=True)
    print(f"DONE {len(wm)} tensors in {len(shards)} shards, {total / 1e9:.1f} GB, {time.time() - t0:.0f}s -> {out}", flush=True)


if __name__ == "__main__":
    main()
