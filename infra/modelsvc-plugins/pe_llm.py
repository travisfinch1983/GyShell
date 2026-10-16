"""Qwen-Image 2.1 Prompt Enhancer runtime, owned by the image model service (claude2, 2026-10-16, Travis via claude1).

Replaces the hand-launched LLM service llama-server-5007 (+ /opt/proxlab/presets/qwen-pe-router.sh): the PEs only serve image
generation, so this service starts and supervises them and brings them back after its own restart or a reboot.

  * ONE llama.cpp server in ROUTER mode (--models-max 1): both ids always listed in /v1/models; asking for the unloaded one swaps
    it in (~4 s). Same shared + per-model settings as qwen-pe-router.sh.
  * Pinned by card UUID (CUDA_VISIBLE_DEVICES=<uuid>) to RTX 5060 Ti #2 - NOT one of this service's own torch GPUs, so it has its
    own pin. (The old 5007 had none: its model process sat on all five ai-epyc cards.)
  * Files from the `llm` cache tiers (RAM > disk > NAS): each (re)start stages them (fetch) and writes the router preset with the
    fastest copy. Per-request use counting stays in the AI-Lab proxy (POST /cache/warm {kind:llm, use:true}).
  * The llama.cpp router ignores SIGTERM (router + child sit in futex waits until SIGKILL), so it runs in its own process group and is
    stopped with TERM -> 3 s -> KILL of the whole group; this service's own shutdown kills it at once (api.add_shutdown).
  * A crashed router is restarted (5 s, backing off to 60 s). A stale group from a previous service process is killed at start.
Config: plugins/pe_llm.json (optional) overrides CONFIG below. Routes: GET /pe/status, POST /pe/restart.
OpenAI endpoint for the AI-Lab proxy (llm backend): http://<host>:<port>/v1 (port 9390)."""
import json
import os
import signal
import subprocess
import threading
import time
import urllib.request

CONFIG = {
    "enabled": True,
    "host": "0.0.0.0",
    "port": 9390,
    "gpu_uuid": "GPU-ed1da178-5c40-6cbf-78ce-b5bf77ccf35b",   # RTX 5060 Ti #2, PCI 0000:22:00.0
    "gpu_label": "RTX 5060 Ti #2 (0000:22:00.0)",
    "binary": "/opt/llama-server/run.sh",
    "models_max": 1,
    "slot_save_path": "/optane-sock1/kvcache/modelsvc-pe",
    "log": "/var/log/proxlab/modelsvc-pe.log",
    "shared": {   # [*] section - copied from qwen-pe-router.sh (llama-server-5006/5009 settings, 2026-10-16)
        "ctx-size": 32768, "gpu-layers": 999, "flash-attn": "auto", "parallel": 1, "jinja": "true", "batch-size": 2048,
        "ubatch-size": 512, "cache-prompt": "true", "cache-ram": 8192, "slot-prompt-similarity": 0.5, "cache-type-k": "f16",
        "cache-type-v": "f16", "split-mode": "layer", "fit": "on", "main-gpu": 0, "reasoning": "auto", "reasoning-budget": 0,
        "chat-template-kwargs": '{"enable_thinking": false}', "temp": 1, "top-k": 20, "top-p": 0.95, "min-p": 0.05,
        "repeat-penalty": 1.05, "metrics": "true", "slots": "true", "stop-timeout": 5},
    "models": {   # id -> {key: file relative to /models}
        "qwen-image-2.1-pe-t2i-heretic": {"model": "Qwen-Image-2.1-PE/T2I-Heretic/GGUF/Q4_K_M/pe_t2i_heretic-Q4_K_M.gguf"},
        "qwen-image-2.1-pe-i2i-heretic": {"model": "Qwen-Image-2.1-PE/I2I-Heretic/GGUF/Q4_K_M/Qwen-Image-2.1-PE-I2I-Heretic-Q4_K_M.gguf",
                                          "mmproj": "Qwen-Image-2.1-PE/I2I-Heretic/GGUF/mmproj/Qwen-Image-2.1-PE-I2I-Heretic-mmproj-F16.gguf"},
    },
}
PRESET = "/run/ailab-modelsvc-pe.ini"
PGID_FILE = "/run/ailab-modelsvc-pe.pgid"
EMPTY_CACHE = "/run/ailab-modelsvc-pe-empty-cache"   # router mode also lists llama.cpp's download cache - point it at nothing


def register(api):
    cfg = json.loads(json.dumps(CONFIG))
    try:
        user = json.load(open(os.path.join(os.path.dirname(__file__), "pe_llm.json")))
        for k, v in user.items():
            cfg[k] = {**cfg[k], **v} if isinstance(cfg.get(k), dict) and isinstance(v, dict) else v
    except FileNotFoundError:
        pass
    if not cfg.get("enabled", True):
        api.log("pe_llm: disabled in pe_llm.json")
        return
    st = {"proc": None, "pgid": None, "state": "starting", "started": None, "restarts": 0, "files": {}, "error": None,
          "stop": False, "want_restart": threading.Event()}
    lock = threading.Lock()
    tier = api.TIERS["llm"]

    def kill_group(pgid, grace=3.0):
        if not pgid:
            return
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            return
        t = time.time()
        while time.time() - t < grace:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.2)
        try:
            os.killpg(pgid, signal.SIGKILL)   # the router ignores SIGTERM
        except ProcessLookupError:
            pass

    def stale():   # a group left by a previous service process (it was SIGKILLed, or this file is from before a crash)
        try:
            pg = int(open(PGID_FILE).read().strip())
        except (OSError, ValueError):
            return
        try:
            os.killpg(pg, 0)
        except ProcessLookupError:
            return
        api.log(f"pe_llm: killing a stale PE router group {pg}")
        kill_group(pg, 1.0)

    def resolve():
        """Stage every file into the tiers (blocking; disk then RAM) and return id -> {key: fastest path}."""
        out = {}
        for mid, files in cfg["models"].items():
            out[mid] = {}
            for key, rel in files.items():
                src = api.full_path("llm", rel)
                try:
                    p = tier.fetch(rel, src, count_use=False)
                except Exception as e:  # noqa: BLE001
                    api.log(f"pe_llm: staging {rel} failed ({e}) - using {src}")
                    p = src
                out[mid][key] = p
        return out

    def write_preset(files):
        lines = ["version = 1", "", "[*]"] + [f"{k} = {v}" for k, v in cfg["shared"].items()]
        for mid, f in files.items():
            lines += ["", f"[{mid}]"] + [f"{k} = {v}" for k, v in f.items()]
        tmp = PRESET + ".tmp"
        open(tmp, "w").write("\n".join(lines) + "\n"); os.replace(tmp, PRESET)

    def start():
        files = resolve()
        missing = [p for f in files.values() for p in f.values() if not os.path.exists(p)]
        if missing:
            raise RuntimeError(f"missing model files: {missing}")
        write_preset(files)
        os.makedirs(EMPTY_CACHE, exist_ok=True)
        if cfg.get("slot_save_path"):
            os.makedirs(cfg["slot_save_path"], exist_ok=True)
        env = {**os.environ, "CUDA_DEVICE_ORDER": "PCI_BUS_ID", "CUDA_VISIBLE_DEVICES": cfg["gpu_uuid"], "LLAMA_CACHE": EMPTY_CACHE}
        env.pop("PYTORCH_CUDA_ALLOC_CONF", None)
        cmd = [cfg["binary"], "--models-preset", PRESET, "--host", cfg["host"], "--port", str(cfg["port"]), "--models-max", str(cfg["models_max"])]
        if cfg.get("slot_save_path"):
            cmd += ["--slot-save-path", cfg["slot_save_path"]]
        log = open(cfg["log"], "ab", buffering=0)
        log.write(f"\n=== {time.strftime('%F %T')} pe_llm start on {cfg['gpu_label']}: {' '.join(cmd)}\n".encode())
        p = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        with lock:
            st.update(proc=p, pgid=p.pid, started=time.time(), files=files, error=None, state="running")
        open(PGID_FILE, "w").write(str(p.pid))
        api.log(f"pe_llm: PE router pid {p.pid} on {cfg['gpu_label']}, port {cfg['port']}")

    def supervise():
        stale()
        backoff = 5
        while not st["stop"]:
            try:
                start()
            except Exception as e:  # noqa: BLE001
                with lock:
                    st.update(state="error", error=f"{type(e).__name__}: {e}")
                api.log(f"pe_llm: start failed: {e}")
                time.sleep(backoff); backoff = min(60, backoff * 2)
                continue
            p = st["proc"]
            while p.poll() is None and not st["stop"] and not st["want_restart"].is_set():
                time.sleep(1)
            if st["want_restart"].is_set():
                st["want_restart"].clear()
                kill_group(st["pgid"]); backoff = 5
                continue
            if st["stop"]:
                break
            up = time.time() - (st["started"] or time.time())
            kill_group(st["pgid"], 1.0)   # the router's child may still be alive
            with lock:
                st.update(state="restarting", error=f"router exited with code {p.returncode} after {up:.0f} s", restarts=st["restarts"] + 1)
            api.log(f"pe_llm: router exited ({p.returncode}) after {up:.0f} s - restarting in {backoff} s")
            backoff = 5 if up > 300 else min(60, backoff * 2)
            time.sleep(backoff)

    def shutdown():
        st["stop"] = True
        kill_group(st["pgid"], 1.0)

    def router_models():
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{cfg['port']}/v1/models", timeout=3) as r:
                d = json.load(r)
            return [{"id": m.get("id"), "status": (m.get("status") or {}).get("value") if isinstance(m.get("status"), dict) else m.get("status")}
                    for m in d.get("data", [])]
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}

    def my_ip():
        import socket
        try:
            k = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); k.connect(("10.0.0.219", 9)); ip = k.getsockname()[0]; k.close(); return ip
        except OSError:
            return os.uname().nodename

    def status(_body, _q):
        with lock:
            p = st["proc"]
            return {"ok": True, "state": st["state"] if p is None or p.poll() is None else "exited", "pid": p and p.pid,
                    "port": cfg["port"], "base_url": f"http://{my_ip()}:{cfg['port']}/v1",
                    "gpu": cfg["gpu_label"], "gpu_uuid": cfg["gpu_uuid"], "uptime_s": round(time.time() - st["started"]) if st["started"] else None,
                    "restarts": st["restarts"], "error": st["error"], "files": st["files"], "models": router_models()}

    def restart(_body, _q):
        st["want_restart"].set()
        return {"ok": True, "restarting": True}

    api.add_route("GET", "/pe/status", status)
    api.add_route("POST", "/pe/restart", restart)
    api.add_shutdown(shutdown)
    threading.Thread(target=supervise, daemon=True, name="pe_llm").start()
