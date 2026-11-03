"""Image -> 3D models served by the image model service (claude1 2026-11-03, Travis: "upload my photos, pick the model, hit go,
and it loads the model on whatever GPU I specify, or automatically").

Models (weights in /imagegen/3d-models, each in its OWN conda env, so they run out of process - see _image3d_worker.py):
  hunyuan3d21  Hunyuan3D-2.1   1 image        mesh + PBR GLB   ~3 min on a 4090, 13.4 GB peak (paint stage)
  trellis2     TRELLIS.2-4B    1 image        mesh + PBR GLB   ~25 s + 1-2 min CPU GLB export, ~3 GB (low_vram)
  uniforge3d   UniForge3D      2+ views       mesh + PBR GLB   ~2.5-3 min, 12 GB
  idol         Idol            1 image        Gaussian splat   ~25 s, 5 GB
GPU eligibility is read from each env's torch build (torch.cuda.get_arch_list()): the 2026-11-03 envs are torch 2.6+cu124
(sm_50..sm_90), so the Blackwell 5060 Tis (sm_120) are NOT eligible until an env is rebuilt on cu128 - no code change needed then.

A job holds its GPU's FIFO queue slot for the whole run (shared with diffusion / TE / VAE work on that card) and first moves this
service's idle models on that card to RAM. The worker stays warm KEEP_WARM s after a job (reloading costs 30 s - 4 min), then exits;
a job for a DIFFERENT 3D model on the same card stops the warm one first.
Jobs + outputs: /imagegen/3d-outputs/<id>/ (job.json, inputs/, model.glb|model.ply, thumb.jpg, ...).

HTTP: GET /image3d/models   POST /image3d/jobs {model, gpu?, name?, images: [{name, data: base64}], options?}
      GET /image3d/jobs     GET /image3d/job?id=   GET /image3d/file?id=&path=   GET /image3d/zip?id=
      POST /image3d/cancel {id}   POST /image3d/delete {id}   POST /image3d/unload {}"""
import base64, io, json, os, queue, re, shutil, subprocess, threading, time, zipfile

OUT = "/imagegen/3d-outputs"
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_image3d_worker.py")
KEEP_WARM = int(os.environ.get("IMAGE3D_KEEP_WARM", "300"))
ENV = "/opt/conda/envs/{}/bin/python"
MODELS = {
    "trellis2": {"label": "TRELLIS.2 (4B)", "env": "trellis2", "input": "single", "output": "mesh", "vram_gb": 8,
                 "time": "~2 min", "notes": "Best single-photo all-rounder: right colours, plausible unseen sides.",
                 "options": {"seed": 42, "pipeline": {"default": "1024_cascade", "choices": ["512", "1024", "1024_cascade", "1536_cascade"]},
                             "faces": 1000000, "texture_size": {"default": 4096, "choices": [1024, 2048, 4096]}}},
    "uniforge3d": {"label": "UniForge3D", "env": "uniforge3d", "input": "multi", "output": "mesh", "vram_gb": 14,
                   "time": "~3 min (+4 min first load)",
                   "notes": "Uses ALL photos (first = front). Most detail from real views; everything in frame gets modelled (hands!).",
                   "options": {}},
    "hunyuan3d21": {"label": "Hunyuan3D-2.1", "env": "hunyuan3d21", "input": "single", "output": "mesh", "vram_gb": 15,
                    "time": "~3 min", "notes": "Cleanest geometry on simple shapes; washes out colour, invents unseen detail.",
                    "options": {"seed": 1234, "steps": 50, "octree": {"default": 384, "choices": [256, 384, 512]}, "texture": True,
                                "views": {"default": 6, "choices": [6, 8, 9]}, "res": {"default": 512, "choices": [512, 768]}}},
    "idol": {"label": "Idol (Gaussian splat)", "env": "idol", "input": "single", "output": "splat", "vram_gb": 6, "time": "~30 s",
             "notes": "Most faithful colour, but a splat (point cloud), not a mesh.",
             "options": {"seed": 42, "mode": {"default": "real", "choices": ["real", "synthetic"]},
                         "gaussians": {"default": 1048576, "choices": [262144, 524288, 1048576]}}},
}
CT = {".glb": "model/gltf-binary", ".ply": "application/octet-stream", ".obj": "text/plain", ".png": "image/png", ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg", ".webp": "image/webp", ".json": "application/json", ".log": "text/plain", ".zip": "application/zip"}


def register(api):
    os.makedirs(OUT, exist_ok=True)
    ARCHS = {}                                   # model -> ["sm_80", ...] from its env's torch build
    JOBS, JLOCK = {}, threading.Lock()
    WORKERS, WLOCK = {}, threading.Lock()        # (model, gpu) -> Worker

    def detect(m):
        py = ENV.format(MODELS[m]["env"])
        if not os.path.exists(py):
            ARCHS[m] = []; api.log(f"image3d: {m} env missing ({py})"); return
        try:
            r = subprocess.run([py, "-c", "import torch; print(','.join(torch.cuda.get_arch_list()))"], capture_output=True, text=True, timeout=120)
            ARCHS[m] = [a for a in r.stdout.strip().split(",") if a]
        except Exception as e:  # noqa: BLE001
            ARCHS[m] = []; api.log(f"image3d: arch probe for {m} failed: {e}")
    threading.Thread(target=lambda: [detect(m) for m in MODELS], daemon=True).start()

    def cc(g):
        return tuple(api.torch.cuda.get_device_capability(api.GPUS[g]))

    def runs_on(m, g):
        """(ok, why) - the env's torch has kernels for this card (sm_XY, or PTX compute_XY <= it) and the card has enough VRAM"""
        info = api.gpu_info(g)
        if info.get("total_gb", 0) < MODELS[m]["vram_gb"]:
            return False, f"needs {MODELS[m]['vram_gb']} GB, card has {info.get('total_gb')}"
        archs = ARCHS.get(m)
        if archs is None:
            return False, "checking the env's CUDA build..."
        if not archs:
            return False, "env not installed"
        maj, mi = cc(g); v = maj * 10 + mi
        # CUDA compatibility: a cubin sm_XY runs on the same MAJOR with minor >= Y (sm_86 code runs on a 4090's sm_89);
        # PTX compute_XY is JIT-compiled for any newer card
        def code(a):
            n = int(a.split("_")[1]); return n // 10, n % 10
        if any(a.startswith("sm_") and code(a)[0] == maj and code(a)[1] <= mi for a in archs) or \
                any(a.startswith("compute_") and int(a.split("_")[1]) <= v for a in archs):
            return True, ""
        return False, f"env's torch has no kernels for sm_{v} (built for {archs[-1]}); rebuild the env on cu128"

    def save(j):
        with open(f"{j['dir']}/job.json.tmp", "w") as f:
            json.dump({k: v for k, v in j.items() if not k.startswith("_")}, f, indent=2)
        os.replace(f"{j['dir']}/job.json.tmp", f"{j['dir']}/job.json")

    # existing jobs from disk (a job that was running when the service stopped is marked interrupted)
    for d in sorted(os.listdir(OUT)):
        p = f"{OUT}/{d}/job.json"
        if os.path.exists(p):
            try:
                j = json.load(open(p))
                if j.get("status") in ("queued", "loading", "running"):
                    j["status"], j["error"] = "error", "interrupted (the image model service restarted)"
                j["dir"] = f"{OUT}/{d}"; JOBS[j["id"]] = j
                if j["status"] == "error":
                    save(j)
            except Exception as e:  # noqa: BLE001
                api.log(f"image3d: unreadable {p}: {e}")

    class Worker:
        def __init__(self, m, g):
            self.m, self.g, self.q, self.proc, self.last = m, g, queue.Queue(), None, time.time()
            self.busy = False

        def alive(self):
            return self.proc is not None and self.proc.poll() is None

        def start(self, on_progress):
            info = api.gpu_info(self.g); uuid = info.get("uuid") or ""
            cvd = (uuid if uuid.startswith("GPU-") else f"GPU-{uuid}") if uuid else str(self.g)
            env = {**os.environ, "CUDA_VISIBLE_DEVICES": cvd, "CUDA_DEVICE_ORDER": "PCI_BUS_ID", "HF_HUB_OFFLINE": "1",
                   "PYTHONUNBUFFERED": "1"}
            env.pop("PYTHONPATH", None)
            self.log = open(f"{OUT}/.worker-{self.m}-gpu{self.g}.log", "a")
            self.log.write(f"\n==== {time.ctime()} start on GPU {self.g} ({info.get('name')})\n"); self.log.flush()
            self.proc = subprocess.Popen([ENV.format(MODELS[self.m]["env"]), WORKER, "--model", self.m], env=env, stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=self.log, text=True, bufsize=1, cwd="/tmp")
            threading.Thread(target=self._read, daemon=True).start()
            t0 = time.time()
            while True:
                try:
                    msg = self.q.get(timeout=5)
                except queue.Empty:
                    if not self.alive():
                        raise RuntimeError(f"{self.m} worker exited while loading (code {self.proc.returncode}); see {self.log.name}")
                    on_progress("loading model", None, round(time.time() - t0))
                    continue
                if msg.get("ready"):
                    api.log(f"image3d: {self.m} up on GPU {self.g} in {msg.get('load_s')} s (pid {self.proc.pid})"); return msg
                if "error" in msg:
                    self.stop(); raise RuntimeError(msg["error"])

        def _read(self):
            for line in self.proc.stdout:
                if line.startswith("@@"):
                    try:
                        self.q.put(json.loads(line[2:]))
                    except ValueError:
                        pass
                else:
                    self.log.write(line); self.log.flush()
            self.q.put({"exited": True})

        def run(self, req, on_progress, cancelled):
            self.busy = True
            try:
                self.proc.stdin.write(json.dumps(req) + "\n"); self.proc.stdin.flush()
                t0 = time.time()
                while True:
                    if cancelled():
                        self.stop(); raise RuntimeError("cancelled")
                    try:
                        msg = self.q.get(timeout=2)
                    except queue.Empty:
                        on_progress(None, None, round(time.time() - t0)); continue
                    if "progress" in msg:
                        on_progress(msg["progress"], msg.get("frac"), round(time.time() - t0))
                    elif "done" in msg:
                        return msg["done"]
                    elif "error" in msg:
                        if msg.get("fatal"):
                            self.stop()
                        raise RuntimeError(msg["error"])
                    elif msg.get("exited"):
                        self.stop(); raise RuntimeError(f"{self.m} worker died mid-run; see {OUT}/.worker-{self.m}-gpu{self.g}.log")
            finally:
                self.busy, self.last = False, time.time()

        def stop(self):
            if self.proc and self.proc.poll() is None:
                try:
                    self.proc.stdin.write('{"cmd": "quit"}\n'); self.proc.stdin.flush(); self.proc.wait(10)
                except Exception:  # noqa: BLE001
                    pass
                if self.proc.poll() is None:
                    self.proc.kill()
            self.proc = None

    def reaper():
        while True:
            time.sleep(30)
            with WLOCK:
                for k, w in list(WORKERS.items()):
                    if w.alive() and not w.busy and time.time() - w.last > KEEP_WARM:
                        api.log(f"image3d: {k[0]} on GPU {k[1]} idle {KEEP_WARM} s - unloading"); w.stop()
    threading.Thread(target=reaper, daemon=True).start()
    api.add_shutdown(lambda: [w.stop() for w in list(WORKERS.values())])

    def pick_gpu(m, want):
        ok = [g for g in range(len(api.GPUS)) if runs_on(m, g)[0]]
        if want is not None and want != "" and str(want).lower() != "auto":
            g = int(want)
            good, why = runs_on(m, g)
            if not good:
                raise RuntimeError(f"GPU {g} ({api.GPU_NAMES[g]}) can't run {m}: {why}")
            return g
        if not ok:
            raise RuntimeError(f"no GPU on this service can run {m} ({'; '.join(f'{g}: ' + runs_on(m, g)[1] for g in range(len(api.GPUS)))})")
        warm = [g for g in ok if (w := WORKERS.get((m, g))) and w.alive()]
        if warm:
            return warm[0]
        return max(ok, key=lambda g: ((api.gpu_info(g).get("queue") or 0) == 0, api.gpu_info(g).get("free_gb", 0)))

    def execute(j):
        m = j["model"]

        def prog(stage, frac, secs):
            if stage:
                j["stage"] = stage
            if frac is not None:
                j["progress"] = frac
            j["elapsed_s"] = secs
        try:
            g = j["gpu"]
            with api.lease_gpus([g], who=f"image3d:{j['id']}") as sess:
                stop_touch = threading.Event()
                threading.Thread(target=lambda: [api.touch_gpus(sess, [g]) for _ in iter(lambda: stop_touch.wait(20), True)],
                                 daemon=True).start()
                try:
                    if j.get("_cancel"):
                        raise RuntimeError("cancelled")
                    j.update(status="loading", stage="preparing GPU", started=time.time()); save(j)
                    with WLOCK:                            # another 3D model warm on this card: it goes first
                        for (om, og), w in list(WORKERS.items()):
                            if og == g and om != m and w.alive():
                                api.log(f"image3d: stopping warm {om} on GPU {g} for {m}"); w.stop()
                        w = WORKERS.setdefault((m, g), Worker(m, g))
                    api.free_vram(g, int(MODELS[m]["vram_gb"] * 1e9))
                    if not w.alive():
                        j["stage"] = "loading model"; info = w.start(prog); j["load_s"] = info.get("load_s")
                    j.update(status="running", stage="starting"); save(j)
                    res = w.run({"cmd": "run", "inputs": j["inputs"], "out": j["dir"], "options": j["options"]}, prog,
                                lambda: j.get("_cancel"))
                finally:
                    stop_touch.set()
            out = "model.ply" if MODELS[m]["output"] == "splat" else "model.glb"
            if not os.path.exists(f"{j['dir']}/{out}"):
                raise RuntimeError(f"the model finished but wrote no {out}")
            j.update(status="done", stage="done", progress=1.0, result=res, output=out, finished=time.time(),
                     files=sorted(f for f in os.listdir(j["dir"]) if not f.startswith(".") and os.path.isfile(f"{j['dir']}/{f}")))
        except Exception as e:  # noqa: BLE001
            j.update(status="cancelled" if str(e) == "cancelled" else "error", error=str(e), finished=time.time())
            api.log(f"image3d: job {j['id']} {j['status']}: {e}")
        save(j)

    def slug(s):
        return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:40] or "object"

    def new_job(body, _q):
        m = body.get("model")
        if m not in MODELS:
            raise RuntimeError(f"model must be one of {list(MODELS)}")
        imgs = body.get("images") or []
        if not imgs:
            raise RuntimeError("no images")
        if MODELS[m]["input"] == "single" and len(imgs) > 1:
            imgs = imgs[:1]                        # single-view models use the first (frontal) photo
        g = pick_gpu(m, body.get("gpu"))
        name = body.get("name") or os.path.splitext(imgs[0].get("name") or "object")[0]
        jid = time.strftime("%Y%m%d-%H%M%S") + f"-{m}-{slug(name)}"
        d = f"{OUT}/{jid}"; os.makedirs(f"{d}/inputs")
        paths = []
        for i, im in enumerate(imgs, 1):
            data = im.get("data") or ""
            raw = base64.b64decode(data.split(",", 1)[1] if data.startswith("data:") else data)
            ext = os.path.splitext(im.get("name") or "")[1].lower()
            ext = ext if ext in (".png", ".jpg", ".jpeg", ".webp") else ".png"
            p = f"{d}/inputs/{i:03d}{ext}"; open(p, "wb").write(raw); paths.append(p)
        try:
            from PIL import Image, ImageOps
            t = ImageOps.exif_transpose(Image.open(paths[0])).convert("RGB"); t.thumbnail((320, 320)); t.save(f"{d}/thumb.jpg", quality=85)
        except Exception as e:  # noqa: BLE001
            api.log(f"image3d: thumbnail failed: {e}")
        opts = {k: (v["default"] if isinstance(v, dict) else v) for k, v in MODELS[m]["options"].items()}
        opts.update({k: v for k, v in (body.get("options") or {}).items() if k in opts})
        j = {"id": jid, "name": name, "model": m, "model_label": MODELS[m]["label"], "output_type": MODELS[m]["output"],
             "gpu": g, "gpu_name": api.GPU_NAMES[g], "options": opts, "inputs": paths, "dir": d, "status": "queued",
             "stage": "queued", "progress": 0.0, "created": time.time()}
        with JLOCK:
            JOBS[jid] = j
        save(j)
        threading.Thread(target=execute, args=(j,), daemon=True, name=f"image3d-{jid}").start()
        return 202, public(j)

    def public(j):
        p = {k: v for k, v in j.items() if not k.startswith("_") and k not in ("dir",)}
        p["inputs"] = [os.path.relpath(x, j["dir"]) for x in j.get("inputs", [])]
        return p

    def get(q):
        j = JOBS.get(q.get("id") or "")
        if not j:
            raise FileNotFoundError(f"no job {q.get('id')!r}")
        return j

    def models(_b, _q):
        gpus = [api.gpu_info(g) for g in range(len(api.GPUS))]
        out = []
        for m, s in MODELS.items():
            out.append({"id": m, **{k: v for k, v in s.items() if k != "env"}, "archs": ARCHS.get(m),
                        "gpus": [{"index": g, "name": api.GPU_NAMES[g], "ok": runs_on(m, g)[0], "why": runs_on(m, g)[1]} for g in range(len(api.GPUS))]})
        return {"models": out, "gpus": gpus, "keep_warm_s": KEEP_WARM,
                "warm": [{"model": k[0], "gpu": k[1], "busy": w.busy} for k, w in WORKERS.items() if w.alive()]}

    def jobs(_b, q):
        with JLOCK:
            js = sorted(JOBS.values(), key=lambda j: j.get("created", 0), reverse=True)
        return {"jobs": [public(j) for j in js]}

    def file(_b, q):
        j = get(q); rel = q.get("path") or j.get("output") or ""
        p = os.path.realpath(os.path.join(j["dir"], rel))
        if not p.startswith(os.path.realpath(j["dir"]) + os.sep) or not os.path.isfile(p):
            return 404, {"error": f"no file {rel!r} in job {j['id']}"}
        return 200, open(p, "rb").read(), CT.get(os.path.splitext(p)[1].lower(), "application/octet-stream")

    def zipjob(_b, q):
        j = get(q); buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for root, _dirs, fs in os.walk(j["dir"]):
                for f in fs:
                    if not f.endswith(".tmp"):
                        p = os.path.join(root, f); z.write(p, os.path.join(j["id"], os.path.relpath(p, j["dir"])))
        return 200, buf.getvalue(), "application/zip"

    def cancel(b, _q):
        j = get(b); j["_cancel"] = True
        return {"ok": True, "status": j["status"]}

    def delete(b, _q):
        j = get(b)
        if j["status"] in ("queued", "loading", "running"):
            raise RuntimeError("cancel the job first")
        shutil.rmtree(j["dir"]); JOBS.pop(j["id"], None)
        return {"ok": True}

    def unload(_b, _q):
        n = 0
        with WLOCK:
            for w in WORKERS.values():
                if w.alive() and not w.busy:
                    w.stop(); n += 1
        return {"ok": True, "stopped": n}

    api.add_route("GET", "/image3d/models", models)
    api.add_route("POST", "/image3d/jobs", new_job)
    api.add_route("GET", "/image3d/jobs", jobs)
    api.add_route("GET", "/image3d/job", lambda b, q: public(get(q)))
    api.add_route("GET", "/image3d/file", file)
    api.add_route("GET", "/image3d/zip", zipjob)
    api.add_route("POST", "/image3d/cancel", cancel)
    api.add_route("POST", "/image3d/delete", delete)
    api.add_route("POST", "/image3d/unload", unload)
    api.log(f"image3d: {len(MODELS)} models, {len(JOBS)} jobs on disk, outputs in {OUT}")
