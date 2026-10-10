"""qwen_edit - a Qwen Image 2.1 EDIT, end to end inside the Image Model Service (claude1, 2026-10-10).

AI-Lab's native tools call this instead of a ComfyUI workflow (first user: watermark removal in the Training Images
browser). Travis: depending on ComfyUI "is just adding a weak link in a chain". It reproduces his working graph
Qwen_21_Watermark_removal_EN_proxyPE:
  prompt enhancer (qwen-image-2.1-pe-i2i through the AI-Lab LLM proxy; it SEES the image and writes a specific edit)
  -> TextEncodeQwenImage21 (the image as reference, resolution 1088)
  -> KSampler euler / simple, cfg 1, 35 steps, with the Image-Consistency LoRA
  -> VAE decode.
Each step is ComfyUI's own LIBRARY code (comfy_extras.nodes_qwen, nodes.common_ksampler), so results match the graph,
but no ComfyUI server is involved.

Where things run:
  text encoder  the service where it is resident (AI-Lab catalog - 9310's 2xV100 te_split today), over the wire
                protocol: the same 'encode' op the ComfyUI Remote CLIP node sends. Tokenizing happens here.
  UNet + VAE    this service, on ONE GPU, holding that GPU's queue slot for the whole run (api.run).

GET  /qwen_edit  -> {ok, unet, resident}       AI-Lab probes this to find services that can edit
POST /qwen_edit  {path (relative to /imagegen) | image (base64 / data URL), prompt, enhance=true, seed, steps=35, cfg=1,
                  sampler="euler", scheduler="simple", resolution=1088, loras=[[name, strength]], unet, te, vae, lane, who}
  -> {image: base64 PNG at the model's resolution, prompt: what was sampled with, enhanced, seconds, width, height}
"""
import base64
import io
import json
import os
import re
import sys
import threading
import time
import urllib.request

import numpy as np
import torch
from PIL import Image

import comfy.model_management as mm
import comfy.model_patcher
import comfy.sd
import comfy.utils
import folder_paths

DEF_UNET = os.environ.get("QWEN_EDIT_UNET", "Qwen_2.1/qwen_image_2.1_int8_convrot.safetensors")
DEF_TE = os.environ.get("QWEN_EDIT_TE", "Qwen_2.1/qwen3vl_8b_bf16.safetensors")
DEF_VAE = os.environ.get("QWEN_EDIT_VAE", "Qwen_2.1/qwen_image_2.1_vae_bf16.safetensors")
PROXY = os.environ.get("AILAB_PROXY", "http://10.0.0.219:17890").rstrip("/")
CATALOG = PROXY + "/api/proxy/imagegen/v1/models"
PE_URL = PROXY + "/api/proxy/llm/v1/chat/completions"
PE_MODEL = "qwen-image-2.1-pe-i2i"
PE_SYSTEM_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qwen_edit_pe_system.md")   # node 633 of the graph
IMAGEGEN = "/imagegen"
DT = {"BF16": torch.bfloat16, "F16": torch.float16, "F32": torch.float32, "F64": torch.float64, "I8": torch.int8, "U8": torch.uint8,
      "I16": torch.int16, "I32": torch.int32, "I64": torch.int64, "F8_E4M3": torch.float8_e4m3fn, "F8_E5M2": torch.float8_e5m2}


# ── prompt enhancer (same request + answer parsing as the AI-Lab PE (proxy) node, comfyui-ailab-pack/pe_proxy.py) ──
PE_SKIP = {"type", "category", "operation", "kind", "mode", "task", "edit_type", "classification", "object", "target"}


def _ok(v):
    return isinstance(v, str) and len(v.strip()) > 60 and "[object" not in v and not re.match(r"^(basic|normal)_edit\b", v.strip(), re.I)


def _pick_obj(o):
    if not isinstance(o, dict):
        return ""
    a = o.get("action")
    if isinstance(a, str) and len(a.strip()) > 40:
        keep = next((v for v in (o.get("preserved"), o.get("context"), o.get("details"), o.get("keep")) if isinstance(v, str) and len(v.strip()) > 15), None)
        return a.strip().rstrip(".; ") + "." + (f" Keep unchanged: {keep.strip()}" if keep else "")
    for k in ("text", "edit", "output", "change", "prompt", "rewritten_prompt", "instruction", "description", "details"):
        if _ok(o.get(k)):
            return o[k].strip()
    for v in o.values():
        x = _pick_obj(v) if isinstance(v, dict) else ""
        if x:
            return x
    longest = sorted([v for k, v in o.items() if k not in PE_SKIP and _ok(v) and len(v.strip()) > 120], key=len, reverse=True)
    return longest[0].strip() if longest else ""


def pe_pick(raw, final=False):
    """First usable prompt in a PE answer: after </think>; JSON in any of its shapes, else plain text (final only)."""
    t = raw
    if "</think>" in t:
        t = t[t.index("</think>") + 8:]
    elif "<think>" in t:
        return ""
    a = t.find("{")
    while a >= 0:
        d, in_str, esc = 0, False, False
        for k in range(a, len(t)):
            c = t[k]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == "{":
                d += 1
            elif c == "}":
                d -= 1
                if d == 0:
                    try:
                        x = _pick_obj(json.loads(t[a:k + 1]))
                        if x:
                            return x
                    except Exception:  # noqa: BLE001
                        pass
                    break
        a = t.find("{", a + 1)
    plain = t.strip()
    if final and 40 < len(plain) < 3000 and "{" not in plain and not re.match(r"^(the user|let me|so this|i need|okay|first|wait)", plain, re.I):
        return plain
    return ""


def _data_url(img, max_side=1024):
    im = img.convert("RGB")
    im.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, format="JPEG", quality=90)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def enhance(img, user_prompt, seed, log, timeout=300, think_budget=3000):
    system = open(PE_SYSTEM_FILE, encoding="utf-8").read()
    content = [{"type": "image_url", "image_url": {"url": _data_url(img)}}, {"type": "text", "text": user_prompt}]
    last = None
    for attempt in range(2):   # one retry with another seed: the PE occasionally answers with only its type label
        body = {"model": PE_MODEL, "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
                "stream": True, "max_tokens": 8000, "temperature": 0.6, "top_p": 0.95, "top_k": 20, "presence_penalty": 1.5,
                "repeat_penalty": 1.08, "seed": (int(seed) + attempt * 7) % (2 ** 31)}
        req = urllib.request.Request(PE_URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        raw, found, seen, t0, n = "", "", "", time.time(), 0
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                for line in r:
                    line = line.decode("utf-8", "ignore").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        ev = json.loads(data)
                    except Exception:  # noqa: BLE001
                        continue
                    seen = ev.get("model") or seen
                    if seen and ((seen != PE_MODEL and "pe-i2i" not in seen.lower()) or seen.startswith("(OR)")):
                        raise RuntimeError(f"prompt enhancer answered by {seen}, not the local {PE_MODEL} - refusing (images stay local)")
                    delta = (ev.get("choices") or [{}])[0].get("delta") or {}
                    raw += delta.get("content") or ""
                    if delta.get("content") or delta.get("reasoning_content"):
                        n += 1
                    if "}" in raw:
                        found = pe_pick(raw)
                        if found:
                            break   # stop before the PE's post-answer repetition loop
                    if time.time() - t0 > timeout or n > think_budget:
                        break
            found = found or pe_pick(raw, final=True)
            if found:
                log(f"qwen_edit: PE {time.time() - t0:.1f}s -> {found[:160]}")
                return found
            last = "the prompt enhancer returned no usable prompt"
        except Exception as e:  # noqa: BLE001
            last = str(e)
            if "refusing" in last:
                break
    raise RuntimeError(f"prompt enhancer: {last}")


# ── text encoder: tokenize here, encode on the service that holds it (as the ComfyUI Remote CLIP node does) ──
def header_sd(path):
    """The file's tensors as weightless meta tensors (small ones - tokenizer data, quant configs - read for real)."""
    import struct
    from safetensors import safe_open
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]; hdr = json.loads(f.read(n))
    hdr.pop("__metadata__", None)
    out = {}
    with safe_open(path, "pt", device="cpu") as f:
        for k, v in hdr.items():
            n = 1
            for d in v["shape"]:
                n *= d
            if n <= 65536 or (v["dtype"] == "U8" and len(v["shape"]) == 1):
                out[k] = f.get_tensor(k)
            else:
                out[k] = torch.empty(v["shape"], dtype=DT.get(v["dtype"], torch.float32), device="meta")
    return out


class _Conn:
    """One persistent wire connection; reconnects once if the service restarted."""
    def __init__(self, endpoint, who):
        self.endpoint, self.who, self.sock, self.lock = endpoint, who, None, threading.RLock()

    def call(self, op, **kw):
        from modelsvc import wire
        with self.lock:
            for attempt in (0, 1):
                try:
                    if self.sock is None:
                        self.sock = wire.connect(self.endpoint)
                    return wire.call(self.sock, op, who=self.who, **kw)
                except (ConnectionError, OSError) as e:
                    try:
                        self.sock and self.sock.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self.sock = None
                    if attempt:
                        raise RuntimeError(f"text-encoder service {self.endpoint} unreachable: {e}") from e


class _ClipOpts(torch.nn.Module):
    def __init__(self):
        super().__init__(); self.opts = {}

    def reset_clip_options(self):
        self.opts = {}

    def set_clip_options(self, o):
        self.opts.update(o)


class RemoteCLIP(comfy.sd.CLIP):
    def clone(self, disable_dynamic=False):
        n = super().clone(disable_dynamic)
        n.__class__ = RemoteCLIP
        n.remote, n.remote_name, n.remote_type = self.remote, self.remote_name, self.remote_type
        return n

    def load_model(self, tokens={}):
        return self.patcher

    def encode_from_tokens(self, tokens, return_pooled=False, return_dict=False):
        opts = {}
        if self.layer_idx is not None:
            opts["layer"] = self.layer_idx
        if return_pooled == "unprojected":
            opts["projected_pooled"] = False
        o = self.remote.call("encode", model=self.remote_name, clip_type=self.remote_type, tokens=tokens, options=opts, loras=[])["out"]
        dev = mm.intermediate_device()
        o = [x.to(dev) if isinstance(x, torch.Tensor) else x for x in o]
        cond, pooled = o[0], o[1] if len(o) > 1 else None
        if return_dict:
            out = {"cond": cond, "pooled_output": pooled}
            if len(o) > 2 and isinstance(o[2], dict):
                for k, v in o[2].items():
                    out[k] = v.to(dev) if isinstance(v, torch.Tensor) else v
            self.add_hooks_to_dict(out)
            return out
        return (cond, pooled) if return_pooled else cond


class _Cap(Exception):
    pass


def _capture(target=None, embedding_directory=None, tokenizer_data={}, **kw):
    raise _Cap(target, embedding_directory, tokenizer_data)


_cap_lock = threading.Lock()


def te_endpoint(name):
    """The service holding text encoder `name`, from the AI-Lab catalog: resident + idle, then resident, then any."""
    with urllib.request.urlopen(CATALOG, timeout=5) as r:
        j = json.loads(r.read())
    rows = [m for m in j.get("models") or [] if m.get("kind") == "te" and m.get("name") == name]
    rows.sort(key=lambda m: (not m.get("loaded"), bool(m.get("busy")), int(m.get("waiting") or 0)))
    if not rows:
        raise RuntimeError(f"no Image Model Service offers the text encoder {name}")
    return f"tcp://{rows[0]['host']}:{rows[0]['port']}"


def build_remote_clip(name, clip_type, who, path):
    sd = header_sd(path)
    ct = getattr(comfy.sd.CLIPType, clip_type.upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
    with _cap_lock:
        real = comfy.sd.CLIP; comfy.sd.CLIP = _capture
        try:
            comfy.sd.load_text_encoder_state_dicts([sd], embedding_directory=folder_paths.get_folder_paths("embeddings"), clip_type=ct)
            raise RuntimeError("qwen_edit: tokenizer capture failed")
        except _Cap as c:
            target, ed, td = c.args
        finally:
            comfy.sd.CLIP = real
    clip = RemoteCLIP(no_init=True)
    clip.tokenizer = target.tokenizer(embedding_directory=ed, tokenizer_data=td)
    clip.cond_stage_model = _ClipOpts()
    clip.patcher = comfy.model_patcher.ModelPatcher(clip.cond_stage_model, load_device=torch.device("cpu"), offload_device=torch.device("cpu"))
    clip.patcher.is_clip = True
    clip.layer_idx, clip.tokenizer_options, clip.use_clip_schedule, clip.apply_hooks_to_conds = None, {}, False, None
    clip.remote, clip.remote_name, clip.remote_type = _Conn(te_endpoint(name), who), name, clip_type
    return clip


def register(api):
    from comfy_extras.nodes_qwen import TextEncodeQwenImage21
    import nodes as comfy_nodes
    core = sys.modules.get("__main__")
    clips = {}   # (te, clip_type) -> tokenizer-only RemoteCLIP (cheap to keep; the endpoint is re-resolved on failure)
    busy = {"n": 0}

    def load_image(body):
        if body.get("image"):
            b = body["image"]
            if b.startswith("data:"):
                b = b.split(",", 1)[1]
            return Image.open(io.BytesIO(base64.b64decode(b)))
        rel = str(body.get("path") or "").lstrip("/")
        if rel.startswith("imagegen/"):
            rel = rel[len("imagegen/"):]
        full = os.path.realpath(os.path.join(IMAGEGEN, rel))
        if not rel or not full.startswith(IMAGEGEN + "/"):
            raise RuntimeError("path must name an image under /imagegen")
        if not os.path.isfile(full):
            raise RuntimeError(f"no such image: {rel}")
        return Image.open(full)

    def info(body, query):
        unet = (query or {}).get("unet") or DEF_UNET
        resident = None
        try:
            resident = bool(core.copies_of(*core.mk("unet", unet)))   # mk: the service's own name normalisation
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True, "unet": unet, "te": DEF_TE, "vae": DEF_VAE, "resident": resident, "busy": busy["n"] > 0}

    def edit(body, query):
        if not isinstance(body, dict):
            return 400, {"error": "JSON body expected"}
        t_all = time.time()
        who = str(body.get("who") or "qwen_edit")
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            return 400, {"error": "prompt is required"}
        seed = int(body.get("seed") if body.get("seed") is not None else int.from_bytes(os.urandom(4), "little"))
        steps, cfg = int(body.get("steps") or 35), float(body.get("cfg") or 1.0)
        sampler, scheduler = str(body.get("sampler") or "euler"), str(body.get("scheduler") or "simple")
        resolution = int(body.get("resolution") if body.get("resolution") is not None else 1088)
        unet, te, vae_name = str(body.get("unet") or DEF_UNET), str(body.get("te") or DEF_TE), str(body.get("vae") or DEF_VAE)
        loras = [(str(n), float(s)) for n, s in (body.get("loras") or [])]
        img = load_image(body)
        img = img.convert("RGBA").convert("RGB") if img.mode in ("P", "LA") else img.convert("RGB")
        used = enhance(img, prompt, seed, api.log) if body.get("enhance", True) else prompt
        key = (te, "qwen_image")
        if key not in clips:
            clips[key] = build_remote_clip(te, "qwen_image", f"qwen_edit:{who}", api.full_path("te", te))
        clip = clips[key]
        pixels = torch.from_numpy(np.asarray(img).astype(np.float32) / 255.0)[None]

        def go(model, device):
            g = api.GPUS.index(device)
            t0 = time.time()
            vae = api.model("vae", vae_name, gpu=g)      # comfy.sd.VAE, a copy on the run's GPU
            out = TextEncodeQwenImage21.execute(clip=clip, prompt=used, negative_prompt="", vae=vae, resolution=resolution,
                                                images={"image_1": pixels})
            positive, negative, latent = out.args
            t_enc = time.time() - t0
            # NO explicit MM_LOCK here: this runs inside api.run (the GPU gate's shared compute section). Waiting for
            # MM_LOCK there can deadlock against a load that holds it and waits for compute to drain; core wraps
            # load_models_gpu so the load below steps out of the shared count by itself (claude2, 2026-10-10).
            m = model.clone()      # the resident copy stays unpatched; this run's LoRAs live on the clone
            for n, s in loras:
                m, _ = comfy.sd.load_lora_for_models(m, None, comfy.utils.load_torch_file(api.full_path("lora", n), safe_load=True), s, 0)
            m.model_options.setdefault("transformer_options", {})["qwen_image21_cache"] = {"device": "auto", "dtype": "default"}
            mm.load_models_gpu([m], force_full_load=True)
            t1 = time.time()
            samples = comfy_nodes.common_ksampler(m, seed, steps, cfg, sampler, scheduler, positive, negative, latent, denoise=1.0)[0]
            t_samp = time.time() - t1
            with torch.no_grad():
                images = vae.decode(samples["samples"])
            if images.dim() == 5:      # video-VAE layout [B, T, H, W, C]
                images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
            api.log(f"qwen_edit for {who} on GPU {g}: encode {t_enc:.1f}s, {steps} steps {t_samp:.1f}s ({t_samp / max(steps, 1):.2f}s/step), "
                    f"{len(loras)} lora(s), {tuple(images.shape)}")
            return images[0].float().clamp(0, 1).cpu()

        busy["n"] += 1
        try:
            res = api.run("unet", unet, go, who=f"qwen_edit:{who}", lane=body.get("lane"))
        finally:
            busy["n"] -= 1
        arr = (res.numpy() * 255.0 + 0.5).astype(np.uint8)
        im = Image.fromarray(arr[..., :3])
        buf = io.BytesIO(); im.save(buf, format="PNG")
        return {"ok": True, "image": base64.b64encode(buf.getvalue()).decode(), "prompt": used, "enhanced": used != prompt,
                "seed": seed, "width": im.width, "height": im.height, "seconds": round(time.time() - t_all, 1)}

    api.add_route("GET", "/qwen_edit", info)
    api.add_route("POST", "/qwen_edit", edit)
    api.log(f"qwen_edit: ready (unet {DEF_UNET}, te {DEF_TE} via the catalog, vae {DEF_VAE})")
