#!/usr/bin/env python3
"""trainer — launch and track YOLO-segmentation detector training, driven from the UI.

WHY A DETACHED SUBPROCESS, not a call inside samd. Training holds a GPU for 20+ minutes.
samd serialises /segment behind a single `_lock` so interactive click-to-annotate stays
responsive; running a trainer under that lock would freeze annotation for the whole run.
So training is spawned with setsid into its own process on its OWN card, and this module
only ever reads its progress off disk.

PROGRESS COMES FROM results.csv, which ultralytics appends one row per epoch. That is the
same file the run's own plots are built from, so it cannot drift from what actually
happened the way a parsed stdout line can.

Run layout:  /imagegen/_datasets/<ds>/runs/<name>/
             job.json  train.log  results.csv  weights/{best,last}.pt
"""
import json, os, re, shlex, signal, subprocess, threading, time

IMAGEGEN = os.environ.get("FORGE_IMAGEGEN", "/imagegen")
ROOT = os.environ.get("FORGE_DATASETS", os.path.join(IMAGEGEN, "_datasets"))
PY = os.environ.get("FORGE_PY", "/opt/conda/envs/comfyui/bin/python")
# The `yolo` console script, NOT `python -m ultralytics.cfg`: that module is a package
# with no __main__ in ultralytics 8.4.33 and dies with "cannot be directly executed"
# before it touches the GPU. Derived from PY so it is always the same environment.
YOLO_BIN = os.environ.get("FORGE_YOLO", os.path.join(os.path.dirname(PY), "yolo"))
FORGE_DIR = os.path.dirname(os.path.abspath(__file__))
STOCK_DIR = os.environ.get("FORGE_STOCK", FORGE_DIR)
DETECTOR_DIR = os.path.join(IMAGEGEN, "ultralytics", "segm")
NAME_OK = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

_lock = threading.Lock()


# ─────────────────────────── GPUs, by name ───────────────────────────
def _alias(name):
    """'NVIDIA GeForce RTX 5060 Ti' -> '5060ti'. The model number is what a human says."""
    n = name.lower().replace("nvidia", "").replace("geforce", "").replace("rtx", "")
    return "".join(n.replace("tesla", "").replace("-", " ").split())


def gpu_inventory():
    """Every GPU with a unique friendly alias, free VRAM, and what is holding it.

    Aliases, not indices: an index says nothing about which card it is, and CUDA's default
    ordering disagrees with nvidia-smi's on this host — which is exactly how a job lands on
    a card nobody evaluated. Every launcher here selects by alias.
    """
    def smi(q):
        try:
            return subprocess.run(["nvidia-smi", "--query-gpu=" + q,
                                   "--format=csv,noheader,nounits"],
                                  capture_output=True, text=True, timeout=20).stdout
        except Exception:
            return ""
    rows = []
    for line in smi("index,name,memory.total,memory.used,utilization.gpu").splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) < 5 or not p[0].isdigit():
            continue
        total, used = int(p[2]), int(p[3])
        rows.append({"index": int(p[0]), "name": p[1], "_slug": _alias(p[1]),
                     "total_mib": total, "used_mib": used, "free_mib": total - used,
                     "utilization_pct": int(p[4]) if p[4].isdigit() else None,
                     "processes": []})
    counts = {}
    for r in rows:
        counts[r["_slug"]] = counts.get(r["_slug"], 0) + 1
    for r in rows:
        r["alias"] = r["_slug"] if counts[r["_slug"]] == 1 else "%s-%d" % (r["_slug"], r["index"])
        r.pop("_slug")
    # "10 GB used" is not actionable without the culprit — the fix is usually "stop that".
    by_uuid = {}
    for line in smi("index,gpu_uuid").splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) == 2 and p[0].isdigit():
            by_uuid[p[1]] = int(p[0])
    try:
        apps = subprocess.run(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,used_memory,process_name",
                               "--format=csv,noheader,nounits"],
                              capture_output=True, text=True, timeout=20).stdout
    except Exception:
        apps = ""
    for line in apps.splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) < 4:
            continue
        idx = by_uuid.get(p[0])
        for r in rows:
            if r["index"] == idx:
                r["processes"].append({"pid": p[1], "used_mib": int(p[2]) if p[2].isdigit() else None,
                                       "name": p[3].split("/")[-1]})
    return rows


def resolve_gpu(spec, inv):
    """'5060ti-3' | '3' -> (index, None) | (None, error). Never guesses."""
    spec = str(spec or "").strip()
    if not spec:
        return None, {"error": "no GPU chosen — pick one by name"}
    low = spec.lower()
    # NAME FIRST: model numbers are digits ('4090'), so a numeric branch ahead of this
    # swallows the most natural thing anyone types and rejects it as a bad index.
    for r in inv:
        if r["alias"] == low:
            return r["index"], None
    if spec.lstrip("-").isdigit():
        i = int(spec)
        if any(r["index"] == i for r in inv):
            return i, None
        return None, {"error": "no GPU with index %d" % i}
    hits = [r for r in inv if low in r["alias"] or low in r["name"].lower()]
    if len(hits) == 1:
        return hits[0]["index"], None
    if not hits:
        return None, {"error": "no GPU matches %r" % spec,
                      "available": [r["alias"] for r in inv]}
    # Ambiguous is an ERROR, never a silent pick.
    return None, {"error": "%r matches %d GPUs — name one exactly" % (spec, len(hits)),
                  "candidates": [r["alias"] for r in hits]}


def vram_estimate(imgsz, batch):
    """Rough training footprint in MiB. An ESTIMATE and labelled as one everywhere it is
    shown — the point is to catch 'that obviously will not fit', not to be exact."""
    return int((2600 + 460 * max(1, int(batch))) * ((max(320, int(imgsz)) / 640.0) ** 2))


# ─────────────────────────── what you can train ───────────────────────────
def list_base_models():
    """Stock weights first, then detectors already trained here.

    `trained` is flagged, not hidden. Training a new round FROM the previous round makes
    'v6 = v5 + more data' — every round inherits every earlier round's mistakes and no run
    is reproducible from stock + a dataset. That is a real choice a human can make, so the
    UI states the consequence rather than removing the option.
    """
    out = []
    for f in sorted(os.listdir(STOCK_DIR)) if os.path.isdir(STOCK_DIR) else []:
        if f.endswith(".pt") and "seg" in f:
            p = os.path.join(STOCK_DIR, f)
            out.append({"path": p, "label": f, "kind": "stock", "trained": False,
                        "size_mib": round(os.path.getsize(p) / 1048576, 1)})
    if os.path.isdir(DETECTOR_DIR):
        for f in sorted(os.listdir(DETECTOR_DIR)):
            if not f.endswith(".pt"):
                continue
            p = os.path.join(DETECTOR_DIR, f)
            out.append({"path": p, "label": f, "kind": "detector", "trained": True,
                        "size_mib": round(os.path.getsize(p) / 1048576, 1),
                        "warn": ("Fine-tuning from an already-trained detector inherits its "
                                 "errors and makes the run non-reproducible from stock "
                                 "weights + this dataset. Prefer a stock yolo*-seg.pt.")})
    return out


def dataset_summary(ds):
    """Tile counts by status, and how many would actually reach the exporter."""
    d = os.path.join(ROOT, ds)
    man_p = os.path.join(d, "manifest.json")
    if not os.path.exists(man_p):
        return None
    man = json.load(open(man_p))
    tiles = man.get("tiles", [])
    st = {}
    for t in tiles:
        st[t["status"]] = st.get(t["status"], 0) + 1
    # Mirrors cmd_export's own SKIP set. `unlabelled` means "nobody has said what is in
    # here" — exporting it as an empty label would assert background, which is a lie.
    skip = {"rejected", "unlabelled"}
    trainable = [t for t in tiles if t["status"] not in skip]
    return {"name": ds, "tiles": len(tiles), "status": st,
            "sources": len(man.get("items", [])),
            "trainable_tiles": len(trainable),
            "positives": sum(1 for t in trainable if t["status"] != "negative" and t["polys"]),
            "negatives": sum(1 for t in trainable if t["status"] == "negative" or not t["polys"]),
            "held_back": st.get("unlabelled", 0) + st.get("rejected", 0)}


def list_datasets():
    if not os.path.isdir(ROOT):
        return []
    out = []
    for n in sorted(os.listdir(ROOT)):
        if NAME_OK.match(n) and os.path.exists(os.path.join(ROOT, n, "manifest.json")):
            s = dataset_summary(n)
            if s:
                out.append(s)
    return out


def list_runs(ds=None):
    """Every run on disk, newest first, with its final metrics if it got that far."""
    out = []
    names = [ds] if ds else [n for n in (os.listdir(ROOT) if os.path.isdir(ROOT) else [])
                             if NAME_OK.match(n)]
    for name in names:
        rdir = os.path.join(ROOT, name, "runs")
        if not os.path.isdir(rdir):
            continue
        for r in sorted(os.listdir(rdir)):
            p = os.path.join(rdir, r)
            if not os.path.isdir(p):
                continue
            rec = {"dataset": name, "run": r, "dir": p,
                   "modified": int(os.path.getmtime(p))}
            jp = os.path.join(p, "job.json")
            if os.path.exists(jp):
                try:
                    rec.update(json.load(open(jp)))
                except Exception:
                    pass
            rec["has_weights"] = os.path.exists(os.path.join(p, "weights", "best.pt"))
            prog = _read_results(p)
            if prog:
                rec["epochs_done"] = prog["epoch"]
                rec["metrics"] = prog["metrics"]
            out.append(rec)
    out.sort(key=lambda r: r["modified"], reverse=True)
    return out


# ─────────────────────────── progress ───────────────────────────
def _read_results(rundir):
    """Last row of results.csv -> {epoch, metrics}. The file ultralytics plots from."""
    p = os.path.join(rundir, "results.csv")
    if not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        if len(lines) < 2:
            return None
        head = [h.strip() for h in lines[0].split(",")]
        last = [v.strip() for v in lines[-1].split(",")]
        row = dict(zip(head, last))
        pick = {"mAP50(M)": "metrics/mAP50(M)", "mAP50-95(M)": "metrics/mAP50-95(M)",
                "precision(M)": "metrics/precision(M)", "recall(M)": "metrics/recall(M)"}
        met = {}
        for label, col in pick.items():
            if row.get(col) not in (None, ""):
                try:
                    met[label] = round(float(row[col]), 4)
                except ValueError:
                    pass
        return {"epoch": int(float(row.get("epoch", 0))), "metrics": met,
                "elapsed_s": int(float(row.get("time", 0) or 0))}
    except Exception:
        return None


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def status(ds, run):
    """Live view of one run, assembled from disk so it survives a samd restart."""
    d = os.path.join(ROOT, ds, "runs", run)
    if not os.path.isdir(d):
        return None
    jp = os.path.join(d, "job.json")
    job = json.load(open(jp)) if os.path.exists(jp) else {"state": "unknown"}
    prog = _read_results(d)
    if prog:
        job["epochs_done"] = prog["epoch"]
        job["metrics"] = prog["metrics"]
        job["elapsed_s"] = prog["elapsed_s"]
    best = os.path.join(d, "weights", "best.pt")
    job["has_weights"] = os.path.exists(best)
    job["best_pt"] = best if job["has_weights"] else None
    # STATE IS DERIVED FROM THE PROCESS, not from the last thing we wrote. A samd restart,
    # an OOM kill or a manual `kill` all leave job.json saying "running" forever otherwise.
    if job.get("state") == "running" and not _alive(job.get("pid")):
        done = job.get("epochs_done", 0) >= job.get("epochs", 0) and job["has_weights"]
        job["state"] = "done" if done else "stopped"
        job["note"] = ("finished" if done else
                       "the trainer is no longer running and the run is short of its epoch "
                       "count — check train.log for an OOM or a CUDA error")
        _write_job(d, job)
    try:
        job["log_tail"] = "".join(open(os.path.join(d, "train.log"),
                                       errors="replace").readlines()[-25:])
    except OSError:
        job["log_tail"] = ""
    return job


def _write_job(d, job):
    tmp = os.path.join(d, "job.json.tmp")
    with open(tmp, "w") as f:
        json.dump(job, f, indent=1)
    os.replace(tmp, os.path.join(d, "job.json"))


# ─────────────────────────── launch ───────────────────────────
def start(req):
    """Validate -> export -> launch detached. Returns (job, None) or (None, error)."""
    ds = str(req.get("dataset", "")).strip()
    if not NAME_OK.match(ds) or not os.path.exists(os.path.join(ROOT, ds, "manifest.json")):
        return None, {"error": "unknown dataset %r" % ds}
    run = str(req.get("run_name", "")).strip()
    if not NAME_OK.match(run):
        return None, {"error": "run name must be 1-64 chars of letters, digits, . _ -"}
    base = str(req.get("base_model", "")).strip()
    if not base or not os.path.exists(base):
        return None, {"error": "base model not found: %r" % base}
    allowed = {m["path"] for m in list_base_models()}
    if base not in allowed:
        # Otherwise this endpoint loads an arbitrary attacker-chosen .pt through torch.
        return None, {"error": "base model is not one of the offered weights"}

    try:
        epochs = max(1, min(1000, int(req.get("epochs", 150))))
        imgsz = max(320, min(1536, int(req.get("imgsz", 640))))
        batch = max(1, min(64, int(req.get("batch", 8))))
        val_frac = min(0.5, max(0.05, float(req.get("val_frac", 0.15))))
        seed = int(req.get("seed", 0))
    except (TypeError, ValueError) as e:
        return None, {"error": "bad numeric option: %s" % e}

    summary = dataset_summary(ds)
    if not summary or summary["trainable_tiles"] < 10:
        return None, {"error": "dataset has %d trainable tiles — label some first"
                               % (summary["trainable_tiles"] if summary else 0),
                      "held_back": summary["held_back"] if summary else 0}

    d = os.path.join(ROOT, ds)
    rundir = os.path.join(d, "runs", run)
    if os.path.exists(rundir):
        # ultralytics would silently write to "<run>2" and the UI would poll an empty dir.
        return None, {"error": "run %r already exists — pick another name" % run,
                      "existing": rundir}

    inv = gpu_inventory()
    idx, err = resolve_gpu(req.get("gpu"), inv)
    if err:
        err["gpus"] = [{"alias": r["alias"], "free_mib": r["free_mib"],
                        "total_mib": r["total_mib"]} for r in inv]
        return None, err
    row = next((r for r in inv if r["index"] == idx), None)
    if row is None:
        return None, {"error": "GPU %s vanished between listing and launch" % idx}
    need = vram_estimate(imgsz, batch)
    if row["free_mib"] < need and not req.get("allow_low_vram"):
        return None, {"error": "%s has %d MiB free; this run needs about %d MiB"
                               % (row["alias"], row["free_mib"], need),
                      "gpu": row["alias"], "free_mib": row["free_mib"], "needed_mib": need,
                      "estimate": True,
                      "busy_with": row["processes"],
                      "fix": ("free the card, pick another, lower the batch size, or "
                              "override if you know the memory frees up first")}
    # One trainer per card. Two runs sharing a GPU do not fail cleanly — they OOM each
    # other partway in, losing both.
    for r in list_runs():
        if r.get("state") == "running" and r.get("gpu_index") == idx and _alive(r.get("pid")):
            return None, {"error": "%s is already training %r/%r"
                                   % (row["alias"], r["dataset"], r["run"]),
                          "fix": "wait for it, stop it, or choose another GPU"}

    # ── export: the dataset the trainer reads is built fresh from the manifest, so a
    # review decision made a minute ago is always in it. Cheap next to training.
    out = os.path.join(d, "ds")
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("forge", os.path.join(FORGE_DIR, "forge.py"))
        forge = importlib.util.module_from_spec(spec); spec.loader.exec_module(forge)
        import shutil
        if os.path.isdir(out):
            shutil.rmtree(out)      # stale tiles from a previous export would still train
        class A: pass
        a = A()
        a.manifest = os.path.join(d, "manifest.json"); a.tiles = os.path.join(d, "tiles")
        a.out = out; a.cls = str(req.get("cls") or ds); a.val_frac = val_frac; a.seed = seed
        forge.cmd_export(a)
    except SystemExit as e:
        return None, {"error": "export refused: %s" % e}
    except Exception as e:
        return None, {"error": "export failed: %s: %s" % (type(e).__name__, e)}

    if not os.path.exists(YOLO_BIN):
        return None, {"error": "the ultralytics launcher is missing at %s" % YOLO_BIN,
                      "fix": "check the conda env, or set FORGE_YOLO"}
    os.makedirs(rundir, exist_ok=True)
    log = os.path.join(rundir, "train.log")
    # CUDA_VISIBLE_DEVICES pins the ONE card, so device=0 below is that card whatever its
    # PCI index. CUDA_DEVICE_ORDER makes the index we screened for VRAM the index we get.
    # 🛑 PIN WITH device=<PCI index>, NOT CUDA_VISIBLE_DEVICES.
    # ultralytics' select_device() OVERWRITES CUDA_VISIBLE_DEVICES from its own `device=`
    # argument before torch initialises CUDA, so a wrapper that pins with CUDA_VISIBLE_DEVICES
    # and passes device=0 is silently overridden and lands on PHYSICAL card 0 every time,
    # whichever card the caller named. That is not theoretical: it sent three runs onto the
    # card holding vLLM (23 MiB free) and each died as "CUDA OutOfMemoryError in
    # TaskAlignedAssigner" -- an error that names neither the GPU nor the real cause.
    # CUDA_DEVICE_ORDER stays, and is what makes ultralytics' index mean the nvidia-smi one.
    inner = (
        "cd %s && CUDA_DEVICE_ORDER=PCI_BUS_ID "
        "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True "
        "%s segment train model=%s data=%s epochs=%d imgsz=%d batch=%d "
        "device=%d project=%s name=%s exist_ok=True seed=%d" % (
            shlex.quote(FORGE_DIR), shlex.quote(YOLO_BIN), shlex.quote(base),
            shlex.quote(os.path.join(out, "data.yaml")), epochs, imgsz, batch, idx,
            shlex.quote(os.path.join(d, "runs")), shlex.quote(run), seed))

    job = {"dataset": ds, "run": run, "state": "launching", "base_model": base,
           "base_is_trained": any(m["path"] == base and m["trained"] for m in list_base_models()),
           "epochs": epochs, "imgsz": imgsz, "batch": batch, "seed": seed,
           "val_frac": val_frac, "gpu": row["alias"], "gpu_index": idx,
           "vram_estimate_mib": need, "gpu_free_at_launch_mib": row["free_mib"],
           "tiles": summary["trainable_tiles"], "positives": summary["positives"],
           "negatives": summary["negatives"], "held_back": summary["held_back"],
           "command": inner, "dir": rundir, "log": log,
           "started": int(time.time()), "pid": None}
    # 🛑 PERSIST BEFORE LAUNCHING. If reporting fails after the process exists, an
    # untracked trainer holds a GPU for 20 minutes and nothing knows its name.
    _write_job(rundir, job)

    pidfile = os.path.join(rundir, "pid")
    launch = ("{ setsid nohup bash -c %s > %s 2>&1 < /dev/null & echo $! > %s; } "
              "> /dev/null 2>&1 < /dev/null" % (shlex.quote(inner), shlex.quote(log),
                                                shlex.quote(pidfile)))
    try:
        subprocess.run(["bash", "-c", launch], timeout=30,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        job["launch_note"] = "%s while launching; checking for the pid file" % type(e).__name__
    pid = None
    for _ in range(20):
        try:
            txt = open(pidfile).read().strip()
            if txt.isdigit():
                pid = int(txt); break
        except OSError:
            pass
        time.sleep(0.5)
    if pid is None:
        job["state"] = "launch_failed"
        job["error"] = "no pid file appeared; the trainer did not start"
        _write_job(rundir, job)
        return None, {"error": "launch failed — see train.log", "log": log, "dir": rundir}
    job["pid"] = pid
    job["state"] = "running"
    _write_job(rundir, job)
    return job, None


def stop(ds, run):
    d = os.path.join(ROOT, ds, "runs", run)
    jp = os.path.join(d, "job.json")
    if not os.path.exists(jp):
        return None, {"error": "no such run"}
    job = json.load(open(jp))
    pid = job.get("pid")
    if not pid or not _alive(pid):
        job["state"] = "stopped"; _write_job(d, job)
        return job, None
    # SIGTERM to the process GROUP: setsid made the trainer a group leader, and ultralytics
    # forks dataloader workers that would otherwise survive and keep holding the card.
    try:
        os.killpg(os.getpgid(int(pid)), signal.SIGTERM)
    except OSError:
        try:
            os.kill(int(pid), signal.SIGTERM)
        except OSError:
            pass
    for _ in range(20):
        if not _alive(pid):
            break
        time.sleep(0.5)
    if _alive(pid):
        try:
            os.killpg(os.getpgid(int(pid)), signal.SIGKILL)
        except OSError:
            pass
    job["state"] = "stopped"
    job["stopped_at"] = int(time.time())
    _write_job(d, job)
    return job, None


def install(ds, run, filename):
    """Copy weights/best.pt into the detector folder ComfyUI and forge both read."""
    import shutil
    d = os.path.join(ROOT, ds, "runs", run)
    best = os.path.join(d, "weights", "best.pt")
    if not os.path.exists(best):
        return None, {"error": "this run has no weights/best.pt yet"}
    fn = (filename or run).strip()
    if not fn.endswith(".pt"):
        fn += ".pt"
    if os.path.basename(fn) != fn or not NAME_OK.match(fn.replace("(", "").replace(")", "")
                                                       .replace(" ", "").replace("+", "")):
        return None, {"error": "bad filename %r" % fn}
    dest = os.path.join(DETECTOR_DIR, fn)
    if os.path.exists(dest):
        return None, {"error": "%s already exists — pick another name" % fn}
    os.makedirs(DETECTOR_DIR, exist_ok=True)
    tmp = dest + ".tmp"
    shutil.copy2(best, tmp)
    os.replace(tmp, dest)           # never leave a half-copied .pt where a loader can see it
    return {"installed": dest, "bytes": os.path.getsize(dest)}, None
