"""Text encoders held split across 2 GPUs (claude1, 2026-10-10).

Why: Qwen 2.1's BF16 text encoder (qwen3vl 8B, ~17.5 GB) on ONE V100 leaves no room for a 14 GB fp16 UNet beside it,
so the pair of cards would be lost to a TE-only role. Split by layers it is ~8.8 GB per card, always resident, and
each card still fits a UNet copy. This is for MEMORY, not speed (one encode is ~0.2-0.5 s either way).

How: the encoder is loaded once on CPU, then its largest transformer block list (Qwen/Llama `layers`, T5 `block`,
...) is cut so both cards carry about the same BYTES; everything else (embeddings, vision tower, norms, a second small
encoder) goes on the first card. Forward-pre-hooks move each module's tensor inputs to that module's device, so the
activations hop cards once. Weights keep their stored dtype; ComfyUI's manual cast computes in fp32 on V100, which
matched an fp32 CPU reference to 0.0004% on the BF16 8B. The encoder lives OUTSIDE ComfyUI's model manager (it would
move the whole model to one load device), so it is never evicted - it is "always loaded" by construction.

Config: <plugins dir>/../te_split-<port>.json  {"splits": [{"model": "<te name>", "clip_type": "qwen_image", "gpus": [0, 1]}]}
  GET  /te_split                 -> config + what is loaded where
  POST /te_split   {model, clip_type, gpus}   add/replace an entry and load it now
  POST /te_split/remove {model}  drop it and free the VRAM
Encodes for a configured (model, clip_type) are served here via api.claim_te; anything else - and any encode that
carries LoRAs - falls through to core unchanged. GPU queue slots are NOT taken: an encode sharing a card with a
sampling run is accepted contention (it is ~0.2 s).
"""
import json
import os
import threading
import time
import traceback


def register(api):
    torch = api.torch
    import comfy.sd
    import folder_paths

    cfg_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            f"te_split-{getattr(api.args, 'port', 'x')}.json")
    lock = threading.RLock()
    loaded = {}      # (model, clip_type) -> {"clip", "gpus", "cut", "n", "gb", "loaded_at", "encodes", "error"}

    def read_cfg():
        try:
            with open(cfg_path) as f:
                return json.load(f)
        except FileNotFoundError:
            return {"splits": []}
        except Exception as e:  # noqa: BLE001
            api.log(f"te_split: {cfg_path} unreadable ({e}) - treating as empty")
            return {"splits": []}

    def write_cfg(c):
        tmp = cfg_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(c, f, indent=2)
        os.replace(tmp, cfg_path)

    def to_dev(o, d):
        if torch.is_tensor(o):
            return o.to(d)
        if isinstance(o, (list, tuple)):
            return type(o)(to_dev(v, d) for v in o)
        if isinstance(o, dict):
            return {k: to_dev(v, d) for k, v in o.items()}
        return o

    def to_cpu(o):
        if torch.is_tensor(o):
            return o.detach().to("cpu")
        if isinstance(o, (list, tuple)):
            return [to_cpu(v) for v in o]
        if isinstance(o, dict):
            return {k: to_cpu(v) for k, v in o.items()}
        return o

    def nbytes(mod, recurse=True):
        return sum(t.numel() * t.element_size() for t in list(mod.parameters(recurse=recurse)) + list(mod.buffers(recurse=recurse)))

    def block_list(csm):
        best, best_b = None, 0
        for name, mod in csm.named_modules():
            if isinstance(mod, torch.nn.ModuleList) and len(mod) >= 4:
                b = nbytes(mod)
                if b > best_b:
                    best, best_b = (name, mod), b
        if best is None:
            raise RuntimeError("no transformer block list found in this text encoder")
        return best

    def place_tensor(mod, d):
        for k, p in list(mod._parameters.items()):
            if p is not None and p.device != d:
                mod._parameters[k] = torch.nn.Parameter(p.data.to(d), requires_grad=False)
        for k, b in list(mod._buffers.items()):
            if b is not None and b.device != d:
                mod._buffers[k] = b.to(d)

    def hop(mod, d):
        mod.register_forward_pre_hook(lambda _m, args, kwargs, d=d: (to_dev(args, d), to_dev(kwargs, d)), with_kwargs=True)

    def load_split(model, clip_type, gpus):
        devs = [api.GPUS[int(g)] for g in gpus]
        t0 = time.time()
        path = api.full_path("te", model) if "|" not in model else None
        paths = [api.full_path("te", p) for p in model.split("|")] if path is None else [path]
        ct = getattr(comfy.sd.CLIPType, (clip_type or "qwen_image").upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
        clip = comfy.sd.load_clip(ckpt_paths=paths, embedding_directory=folder_paths.get_folder_paths("embeddings"),
                                  clip_type=ct, model_options={"load_device": devs[0], "initial_device": torch.device("cpu")})
        csm = clip.cond_stage_model
        name, blocks = block_list(csm)
        in_blocks = {id(m) for m in blocks.modules()}
        rest = sum(nbytes(m, recurse=False) for m in csm.modules() if id(m) not in in_blocks)
        sizes = [nbytes(b) for b in blocks]
        total = rest + sum(sizes)
        # cut so card A (rest + blocks[:cut]) and card B (blocks[cut:]) carry about the same bytes
        acc, cut = rest, 0
        while cut < len(blocks) and abs((acc + sizes[cut]) - (total - acc - sizes[cut])) < abs(acc - (total - acc)):
            acc += sizes[cut]; cut += 1
        for g, need in zip(gpus, (acc, total - acc)):       # room first: this service's idle models go to RAM
            try:
                api.free_vram(int(g), int(need * 1.1))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        for i, b in enumerate(blocks):
            d = devs[0] if i < cut else devs[1]
            b.to(d)
            hop(b, d)
        for m in csm.modules():
            if id(m) in in_blocks:
                continue
            place_tensor(m, devs[0])
            if m._parameters or m._buffers:
                hop(m, devs[0])
        gb = [round(acc / 1e9, 2), round((total - acc) / 1e9, 2)]
        api.log(f"te_split: {model} ({clip_type}) {name}: {len(blocks)} blocks, 0..{cut - 1} on GPU {gpus[0]} ({gb[0]} GB), "
                f"{cut}..{len(blocks) - 1} on GPU {gpus[1]} ({gb[1]} GB), loaded in {time.time() - t0:.1f}s")
        return {"clip": clip, "gpus": list(gpus), "cut": cut, "n": len(blocks), "gb": gb, "loaded_at": time.time(), "encodes": 0, "error": None}

    def ensure(entry):
        key = (entry["model"], entry.get("clip_type", "qwen_image"))
        with lock:
            cur = loaded.get(key)
            if cur and cur.get("clip") is not None and cur["gpus"] == list(entry["gpus"]):
                return cur
            if cur:
                unload(key)
            try:
                loaded[key] = load_split(key[0], key[1], entry["gpus"])
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                loaded[key] = {"clip": None, "gpus": list(entry["gpus"]), "error": f"{type(e).__name__}: {e}"}
                api.log(f"te_split: FAILED to load {key[0]}: {e} - its encodes fall back to core")
            return loaded[key]

    def unload(key):
        cur = loaded.pop(key, None)
        if cur and cur.get("clip") is not None:
            cur["clip"] = None
            import gc
            gc.collect()
            torch.cuda.empty_cache()

    def claim(sess, m):
        if m.get("loras"):
            return None                     # TE LoRAs: core loads its own patched copy
        key = (m.get("model"), m.get("clip_type", "qwen_image"))
        entry = next((e for e in read_cfg().get("splits", []) if (e["model"], e.get("clip_type", "qwen_image")) == key), None)
        if entry is None:
            return None
        st = ensure(entry)
        clip = st.get("clip")
        if clip is None:
            return None                     # failed to load: core serves it (logged above)
        t0 = time.time()
        with lock:
            csm = clip.cond_stage_model
            csm.reset_clip_options()
            for k, v in (m.get("options") or {}).items():
                csm.set_clip_options({k: v})
            dev = api.GPUS[int(st["gpus"][0])]
            csm.set_clip_options({"execution_device": dev})
            with torch.no_grad(), torch.cuda.device(dev):
                o = csm.encode_token_weights(m["tokens"])
            st["encodes"] += 1
        api.log(f"te_split encode {key[0]} on GPUs {st['gpus']} {time.time() - t0:.2f}s")
        return {"out": to_cpu(list(o))}

    def r_status(body, query):
        return {"config": cfg_path, "splits": read_cfg().get("splits", []),
                "loaded": [{"model": k[0], "clip_type": k[1], **{x: v.get(x) for x in ("gpus", "cut", "n", "gb", "loaded_at", "encodes", "error")}}
                           for k, v in loaded.items()]}

    def r_add(body, query):
        b = body if isinstance(body, dict) else {}
        model, ct, gpus = b.get("model"), b.get("clip_type", "qwen_image"), b.get("gpus") or [0, 1]
        if not model or len(gpus) != 2 or any(int(g) >= len(api.GPUS) for g in gpus) or int(gpus[0]) == int(gpus[1]):
            return 400, {"error": f"need model and 2 distinct gpus of 0..{len(api.GPUS) - 1}"}
        c = read_cfg()
        c["splits"] = [e for e in c.get("splits", []) if e["model"] != model] + [{"model": model, "clip_type": ct, "gpus": [int(g) for g in gpus]}]
        write_cfg(c)
        st = ensure(c["splits"][-1])
        return {"ok": st.get("clip") is not None, "error": st.get("error"), "gb": st.get("gb"), "cut": st.get("cut")}

    def r_remove(body, query):
        model = (body or {}).get("model") if isinstance(body, dict) else None
        c = read_cfg()
        c["splits"] = [e for e in c.get("splits", []) if e["model"] != model]
        write_cfg(c)
        with lock:
            for k in [k for k in loaded if k[0] == model]:
                unload(k)
        return {"ok": True}

    api.claim_te(claim)
    api.add_route("GET", "/te_split", r_status)
    api.add_route("POST", "/te_split", r_add)
    api.add_route("POST", "/te_split/remove", r_remove)

    def preload():
        for e in read_cfg().get("splits", []):
            ensure(e)
    threading.Thread(target=preload, name="te_split-preload", daemon=True).start()
    api.log(f"te_split plugin ready ({len(read_cfg().get('splits', []))} configured; {cfg_path})")
