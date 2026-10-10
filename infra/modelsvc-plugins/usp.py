"""Sequence-parallel (USP / Ulysses) UNet runs for the Image Model Service (claude1, 2026-10-10).

One image's model calls are split across N GPUs of this service: raylight (vendored at
/opt/ailab-modelsvc/vendor/raylight, commit in VENDORED_FROM_COMMIT, + the krea2 GGUF arch patch) keeps one
worker process per GPU, each holding a replica, with xDiT's Ulysses attention injected; every forward is sent to
all ranks (full inputs; the injected forward splits the tokens and all-gathers) and rank 0's output returns.
Measured on 2x V100 NV2 (Krea 2): 1.5-1.6x per image. Output is NOT bit-identical to a single GPU (fp16 split
rounding, ~0.5% mean diff) - unlike CFG split.

Ops (the Remote UNET node's "usp (N GPUs)" mode; same shapes as begin/forward/end in serve.py):
  usp_begin   {model, loras, gpus: N, group, lane} -> {ok, gpus}
  usp_forward {x, t, args, put}                    -> {out}
  usp_end     {}                                   -> {ok}
Only models matching USP_MODELS (regex, default Krea 2) are accepted: raylight's Qwen 2.1 path is BETA and was
SLOWER than one GPU in our tests. LoRAs are merged into the workers' weights at group spawn. One warm worker
group per service, keyed by model + LoRAs + GPUs; a run with a different key replaces it (~16 s + load).
"""
import os
import re
import sys
import concurrent.futures
import threading
import time
import traceback

VENDOR = os.environ.get("USP_RAYLIGHT_SRC", "/opt/ailab-modelsvc/vendor/raylight/src")
ALLOW = re.compile(os.environ.get("USP_MODELS", r"(?i)krea[-_ ]?2"))
ATTENTION = os.environ.get("USP_ATTENTION", "TORCH_EFFICIENT")   # V100: memory-efficient SDPA (FA2 needs sm80)


def register(api):
    torch = api.torch
    lock = threading.Lock()            # one group change / spawn at a time
    # 🛑 Ray starts its GCS + raylet with PR_SET_PDEATHSIG, which fires when the THREAD that started them exits, not
    # the process. ray.init from a request's handler thread therefore killed the whole Ray cluster ~1 s after that
    # client disconnected - and Ray's driver then terminated the service ("Failed to connect to GCS ... will terminate",
    # svc-9310 2026-10-10 03:45). Every ray.init / ray.kill runs on this one long-lived thread instead.
    ray_thread = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="usp-ray")
    # Own Ray temp dir: raylight's initializer rmtree()s <RAYLIGHT_RAY_TMPDIR>/ray, so any other raylight process on
    # this host (the /opt/comfyui-raylight test bed) sharing the default /tmp/raylight-ray would delete our live session.
    os.environ.setdefault("RAYLIGHT_RAY_TMPDIR", f"/tmp/ailab-modelsvc-ray-{getattr(api.args, 'port', 'x')}")
    group = {"key": None, "actors": None, "gpus": None, "loaded_at": 0.0}
    runs = {}                          # id(session) -> run state

    def _imports():
        if VENDOR not in sys.path:
            sys.path.insert(0, VENDOR)
        import ray                                           # noqa: F401
        import raylight.nodes as rn
        from raylight.expansion.comfyui_gguf.nodes import RayGGUFLoader
        return rn, RayGGUFLoader

    def _pick_gpus(n, lane):
        idx = list(range(len(api.GPUS)))
        if lane and lane != "auto":
            idx = [i for i in idx if lane.lower() in api.GPU_NAMES[i].lower()]
        if len(idx) < n:
            raise RuntimeError(f"usp needs {n} GPUs{f' of type {lane}' if lane and lane != 'auto' else ''}; "
                               f"this service has {len(idx)} ({', '.join(api.GPU_NAMES)})")
        try:   # prefer the cards with the most free VRAM
            idx.sort(key=lambda i: -float(api.gpu_info(i).get("free_gb") or 0))
        except Exception:  # noqa: BLE001
            pass
        return sorted(idx[:n])

    def _kill_group():
        if group["actors"] is None:
            return
        try:
            import ray
            for a in group["actors"][0].get("workers", []):
                try:
                    ray.kill(a)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        group.update(key=None, actors=None, gpus=None)

    def _physical(gpus):
        # Service GPU i = the i-th card of ITS CUDA_VISIBLE_DEVICES (the AI-Lab pin), NOT physical card i.
        # raylight's GPU_SELECT would hand Ray "0,1" = physical 0,1 = some other service's cards.
        cvd = [c.strip() for c in (os.environ.get("CUDA_VISIBLE_DEVICES") or "").split(",") if c.strip()]
        if not cvd:
            return [str(g) for g in gpus]
        return [cvd[g] for g in gpus]

    def _ensure_group(model, loras, gpus):
        key = (model, loras, tuple(gpus))
        if group["key"] == key and group["actors"] is not None:
            return group["actors"]
        rn, RayGGUFLoader = _imports()
        _kill_group()
        t0 = time.time()
        n = len(gpus)
        phys = _physical(gpus)
        saved = os.environ.get("CUDA_VISIBLE_DEVICES")
        os.environ["CUDA_VISIBLE_DEVICES"] = ",".join(phys)   # what ray.init's raylet sees; each actor gets one of these
        os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
        try:
            (init,) = rn.RayInitializer().spawn_actor(
            ray_cluster_address="local", ray_cluster_namespace="ailab-modelsvc-usp", GPU=n, ulysses_degree=n,
            ring_degree=1, cfg_degree=1, dp_degree=1, sync_ulysses=False, clear_vram_after_sampling=False,
            FSDP=False, FSDP_CPU_OFFLOAD=False, XFuser_attention=ATTENTION, skip_comm_test=True, use_mmap=True)
        finally:
            if saved is None:
                os.environ.pop("CUDA_VISIBLE_DEVICES", None)
            else:
                os.environ["CUDA_VISIBLE_DEVICES"] = saved
        # LoRAs are merged into each worker's weights at load (raylight's RAY_LORA list), so a different LoRA
        # set means a different group: the warm group is keyed by model + LoRAs + GPUs.
        lora = [{"path": api.full_path("lora", n), "strength_model": s} for n, s in loras] or None
        if model.lower().endswith(".gguf"):
            (actors,) = RayGGUFLoader().load_ray_unet(init, model, "default", "default", lora=lora)
        else:
            (actors,) = rn.RayUNETLoader().load_ray_unet(init, model, "default", lora=lora)
        group.update(key=key, actors=(actors,), gpus=list(gpus), loaded_at=time.time())
        api.log(f"usp group ready: {model}{f' + loras {[n for n, _ in loras]}' if loras else ''} on GPUs {gpus} = physical {phys} ({', '.join(api.GPU_NAMES[g] for g in gpus)}) in {time.time() - t0:.1f}s")
        return group["actors"]

    def _resolve(o, cache):
        if isinstance(o, dict):
            if "__ref" in o:
                return cache[o["__ref"]]
            return {k: _resolve(v, cache) for k, v in o.items()}
        if isinstance(o, list):
            return [_resolve(v, cache) for v in o]
        if isinstance(o, tuple):
            return tuple(_resolve(v, cache) for v in o)
        return o

    def usp_begin(sess, m):
        model = str(m.get("model") or "")
        if not ALLOW.search(model):
            raise RuntimeError(f"USP is not enabled for {model!r} (allowed: /{ALLOW.pattern}/). raylight's support for "
                               f"other models is BETA or untested here; use multi_gpu 'cfg' or 'off'.")
        if model.startswith("ckpt:"):
            raise RuntimeError("USP runs take a diffusion-model file (UNET / GGUF), not a checkpoint (ckpt:)")
        loras = tuple((str(n), float(s)) for n, s in (m.get("loras") or []) if float(s) != 0.0)
        usp_end(sess, {})                                   # a fresh run from the same session
        n = int(m.get("gpus") or 2)
        gpus = _pick_gpus(n, m.get("lane"))
        ctx = api.lease_gpus(gpus, getattr(sess, "who", "usp"), group=m.get("group"))
        lease = ctx.__enter__()
        try:
            for g in gpus:                                   # make room: idle resident models go to RAM
                try:
                    api.free_vram(g, 1 << 40)
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
            with lock:
                actors = ray_thread.submit(_ensure_group, model, loras, gpus).result()
        except Exception:
            ctx.__exit__(*sys.exc_info())
            raise
        runs[id(sess)] = {"ctx": ctx, "lease": lease, "gpus": gpus, "actors": actors, "cache": {},
                          "t0": time.time(), "steps": 0, "compute": 0.0, "touched": time.time()}
        return {"ok": True, "gpus": gpus}

    def _worker_forward(model, payload):
        # Runs INSIDE each raylight worker; a nested function, so cloudpickle ships it by value
        # (the plugin module is loaded from a file path and is not importable there).
        x, t, args = payload
        import torch as T
        import comfy.model_management as mm
        mm.load_models_gpu([model], force_full_load=True)    # ON_LOAD -> USP injection (no-op once loaded)
        dev, dt = model.load_device, model.model.get_dtype()

        def to(o):
            if T.is_tensor(o):
                return o.to(dev, dtype=dt) if (o.is_floating_point() and o.dtype != T.float32) else o.to(dev)
            if isinstance(o, dict):
                return {k: to(v) for k, v in o.items()}
            if isinstance(o, (list, tuple)):
                return type(o)(to(v) for v in o)
            return o
        a = to(dict(args))
        topts = dict(a.pop("transformer_options", None) or {})
        topts.setdefault("wrappers", {}); topts.setdefault("callbacks", {})
        # no_grad, NOT inference_mode: weights patched under inference_mode (LoRA merge at load) become inference tensors,
        # and ComfyUI's later unload of them fails ("Cannot set version_counter for inference tensor") - claude2, 2026-10-10.
        with T.no_grad(), T.cuda.device(dev):
            out = model.model.diffusion_model(to(x), to(t), transformer_options=topts, **a)
        if not T.is_tensor(out):
            out = out[0]
        return out.to("cpu")

    def usp_forward(sess, m):
        run = runs.get(id(sess))
        if run is None:
            raise RuntimeError("usp_forward without usp_begin")
        import ray
        for k, v in (m.get("put") or {}).items():
            run["cache"][k] = v.detach().to("cpu") if torch.is_tensor(v) else v
        args = _resolve(m.get("args") or {}, run["cache"])
        if time.time() - run["touched"] > 30:
            api.touch_gpus(run["lease"], run["gpus"]); run["touched"] = time.time()
        payload = ray.put((m["x"].to("cpu"), m["t"].to("cpu"), args))
        t0 = time.time()
        workers = run["actors"][0]["workers"]
        outs = ray.get([w.model_function_runner_get_values.remote(_worker_forward, payload) for w in workers])
        run["compute"] += time.time() - t0; run["steps"] += 1
        return {"out": outs[0]}

    def usp_end(sess, m):
        run = runs.pop(id(sess), None)
        if run is None:
            return {"ok": True}
        api.log(f"usp run done for {getattr(sess, 'who', '?')}: {run['steps']} model calls on GPUs {run['gpus']}, "
                f"{run['compute']:.1f}s in workers, wall {time.time() - run['t0']:.1f}s")
        try:
            run["ctx"].__exit__(None, None, None)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        return {"ok": True}

    def usp_status(body, query):
        return {"group": {"model": group["key"][0] if group["key"] else None,
                          "loras": [list(x) for x in group["key"][1]] if group["key"] else [], "gpus": group["gpus"],
                          "loaded_at": group["loaded_at"]}, "active_runs": len(runs),
                "allow": ALLOW.pattern, "attention": ATTENTION}

    api.add_op("usp_begin", usp_begin)
    api.add_op("usp_forward", usp_forward)
    api.add_op("usp_end", usp_end)
    api.add_route("GET", "/usp/status", usp_status)
    api.log(f"usp plugin ready (raylight {VENDOR}; models /{ALLOW.pattern}/; attention {ATTENTION})")

