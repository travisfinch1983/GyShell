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
used to carry LoRAs
- fell through to core unchanged. That loaded a SECOND full copy of the encoder on one card for every TE LoRA
(Travis 2026-11-04: qwen3vl 8B split on V100 #4+#5 plus a 17.5 GB LoRA copy on #4). TE LoRAs are now patched INTO
the split weights in place, on whichever card each weight lives, computed in fp32 and rounded back to the stored
dtype (ComfyUI's own helper would use fp16 on V100: the bf16 overflow class). The originals are kept in RAM and put
back when a different LoRA set (or none) arrives, so a run of encodes with the same LoRAs patches once. GPU queue slots are NOT taken: an encode sharing a card with a
sampling run is accepted contention (it is ~0.2 s).
"""
import json
import os
import sys
import threading
import time
import traceback


def register(api):
    torch = api.torch
    import comfy.sd
    import comfy.float
    import comfy.lora
    import comfy.model_patcher
    import comfy.utils
    import folder_paths

    cfg_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            f"te_split-{getattr(api.args, 'port', 'x')}.json")
    lock = threading.RLock()
    # core's model-memory lock: weight moves must hold it (the GPU gate makes memory work exclusive across the
    # process's GPUs - claude2, 2026-10-10). Order is ALWAYS lock -> MM_LOCK.
    mm_lock = getattr(sys.modules.get('__main__'), 'MM_LOCK', None) or threading.RLock()
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
        with mm_lock:
            for g, need in zip(gpus, (acc, total - acc)):   # room first: this service's idle models go to RAM
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

    def restore(st):
        """Put the original weights back (from the RAM backup taken when the LoRAs were applied)."""
        bk = st.pop("lora_backup", None) or {}
        csm = st["clip"].cond_stage_model
        for k, w in bk.items():
            comfy.utils.get_attr(csm, k).data.copy_(w, non_blocking=False)
        st["lora_key"] = ()

    def apply_loras(st, loras):
        """Make the split weights carry exactly `loras` [(name, strength)...]. Returns None when it can't (core then
        serves the encode with its own copy, as before)."""
        key = tuple((str(n), float(s)) for n, s in loras or [])
        if st.get("lora_key", ()) == key:
            return True
        t0 = time.time()
        restore(st)
        if not key:
            api.log(f"te_split: LoRAs removed from the split encoder in {time.time() - t0:.1f}s")
            return True
        lora_sd = getattr(sys.modules.get('__main__'), 'lora_sd', None)
        if lora_sd is None:
            return None
        x = st["clip"]
        for n, s in key:
            _, x = comfy.sd.load_lora_for_models(None, x, lora_sd(n), 0, s)
        patcher, csm = x.patcher, st["clip"].cond_stage_model
        if patcher.model is not csm:
            return None
        backup = {}
        try:
            for k in list(patcher.patches.keys()):
                w, set_func, convert_func = comfy.model_patcher.get_key_weight(csm, k)
                if set_func is not None or convert_func is not None:
                    raise RuntimeError(f"quantized weight {k}")   # int8/fp8 storage: not patched here
                backup[k] = w.detach().to("cpu", copy=True)
                out = comfy.lora.calculate_weight(patcher.patches[k], w.to(torch.float32, copy=True), k)
                w.data.copy_(comfy.float.stochastic_rounding(out, w.dtype, seed=comfy.utils.string_to_seed(k)))
                del out
        except Exception as e:  # noqa: BLE001
            st["lora_backup"] = backup
            restore(st)
            api.log(f"te_split: could not apply LoRAs {[n for n, _ in key]} in place ({e}) - core serves this encode")
            return None
        st["lora_backup"], st["lora_key"] = backup, key
        torch.cuda.empty_cache()
        if backup:
            api.log(f"te_split: applied LoRAs {[n for n, _ in key]} to {len(backup)} weights in place on GPUs {st['gpus']} "
                    f"in {time.time() - t0:.1f}s")
        else:   # the usual case for Qwen/Krea LoRAs: diffusion-model weights only, the clip strength is a no-op
            api.log(f"te_split: LoRAs {[n for n, _ in key]} carry no text-encoder weights - nothing to patch, encoding as-is")
        return True

    def claim(sess, m):
        key = (m.get("model"), m.get("clip_type", "qwen_image"))
        entry = next((e for e in read_cfg().get("splits", []) if (e["model"], e.get("clip_type", "qwen_image")) == key), None)
        if entry is None:
            return None
        # An exact-card pick from the remote nodes (lane "gpu:N" / "gpu:a,b", claude2 2026-10-11) must be honoured: the
        # claim runs BEFORE placement, so ignoring it silently encoded split on [0,1] whatever card was chosen.
        lane = str(m.get("lane") or "")
        if lane.startswith("gpu:"):
            want = sorted(int(x) for x in lane[4:].split(",") if x.strip().isdigit())
            if want != sorted(int(g) for g in entry["gpus"]):
                return None                 # not this split's pair: core places a whole copy on the chosen card(s)
        st = ensure(entry)
        clip = st.get("clip")
        if clip is None:
            return None                     # failed to load: core serves it (logged above)
        t0 = time.time()
        devs = [api.GPUS[int(g)] for g in st["gpus"]]

        def once():
            csm = clip.cond_stage_model
            csm.reset_clip_options()
            for k, v in (m.get("options") or {}).items():
                csm.set_clip_options({k: v})
            csm.set_clip_options({"execution_device": devs[0]})
            with torch.no_grad(), torch.cuda.device(devs[0]):
                return csm.encode_token_weights(m["tokens"])

        with lock:
            if apply_loras(st, m.get("loras")) is None:
                return None
            # Working memory is measured on every encode: image inputs (Qwen-VL vision tower, on card A) need GBs on top
            # of the resident weights, and nothing outside this plugin budgets for it.
            base, free0 = [], []
            for d in devs:
                torch.cuda.reset_peak_memory_stats(d)
                base.append(torch.cuda.memory_allocated(d)); free0.append(torch.cuda.mem_get_info(d)[0])
            retried = False
            try:
                o = once()
            except torch.OutOfMemoryError as e:
                # Same recovery as core's TE encode: move this service's other models on these cards to RAM, retry once.
                # free_vram only moves IDLE models (never one mid-step / in an active run / under a lease - claude2's
                # free_idle), so a running job is never aborted for an encode. Ask for 2x the largest working set seen.
                need = int(max(4e9, 2e9 * max([1.0] + list((st.get("last") or {}).get("peak_extra_gb") or []))))
                api.log(f"te_split encode {key[0]} OOM ({str(e).splitlines()[0][:160]}) - freeing up to {need / 1e9:.0f} GB "
                        f"of IDLE models on GPUs {st['gpus']} and retrying once")
                for g in st["gpus"]:
                    try:
                        api.free_vram(int(g), need)
                    except Exception:  # noqa: BLE001
                        traceback.print_exc()
                torch.cuda.empty_cache()
                base = []
                for d in devs:                      # re-baseline: the eviction above changed what is allocated
                    torch.cuda.reset_peak_memory_stats(d)
                    base.append(torch.cuda.memory_allocated(d))
                retried = True
                try:
                    o = once()
                except torch.OutOfMemoryError as e2:
                    raise RuntimeError(f"te_split: not enough VRAM for this encode on GPUs {st['gpus']} even after moving idle models "
                                       f"to RAM (the rest are in use by running jobs): {str(e2).splitlines()[0][:200]}") from None
            peak = [round((torch.cuda.max_memory_allocated(d) - b) / 1e9, 2) for d, b in zip(devs, base)]
            st["encodes"] += 1
            st["last"] = {"seconds": round(time.time() - t0, 2), "peak_extra_gb": peak,
                          "free_before_gb": [round(f / 1e9, 2) for f in free0], "retried_after_oom": retried, "at": time.time()}
        api.log(f"te_split encode {key[0]} on GPUs {st['gpus']} {time.time() - t0:.2f}s, working memory "
                f"+{peak[0]}/+{peak[1]} GB (free before {st['last']['free_before_gb']}){' after OOM retry' if retried else ''}")
        return {"out": to_cpu(list(o))}

    def r_status(body, query):
        return {"config": cfg_path, "splits": read_cfg().get("splits", []),
                "loaded": [{"model": k[0], "clip_type": k[1], **{x: v.get(x) for x in ("gpus", "cut", "n", "gb", "loaded_at", "encodes", "last", "error")},
                            "loras": [list(x) for x in v.get("lora_key", ())]}
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

    def status():
        # The split TE lives outside the core's MODELS, so without this the managers show ~11 GB used on two cards and
        # "nothing loaded" (claude2's add_status hook). busy = an encode or (re)load holds the lock right now.
        busy = not lock.acquire(blocking=False)
        if not busy:
            lock.release()
        return [{"kind": "te", "name": k[0], "clip_type": k[1], "gpus": v["gpus"], "vram_gb": round(sum(v["gb"]), 2),
                 "uses": v.get("encodes", 0), "busy": busy, "loras": [list(x) for x in v.get("lora_key", ())],
                 "idle_s": round(time.time() - (v.get("last") or {}).get("at", v["loaded_at"]))}
                for k, v in list(loaded.items()) if v.get("clip") is not None]

    api.add_status(status)
    api.claim_te(claim)
    api.add_route("GET", "/te_split", r_status)
    api.add_route("POST", "/te_split", r_add)
    api.add_route("POST", "/te_split/remove", r_remove)

    def preload():
        for e in read_cfg().get("splits", []):
            ensure(e)
    threading.Thread(target=preload, name="te_split-preload", daemon=True).start()
    api.log(f"te_split plugin ready ({len(read_cfg().get('splits', []))} configured; {cfg_path})")
