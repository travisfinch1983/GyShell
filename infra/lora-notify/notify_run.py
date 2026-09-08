#!/usr/bin/env python3
"""Tell a fleet agent that a LoRA training run has ended, and how.

WHY THIS EXISTS. Loom launches a training run and then has no way to know it finished: she has
no wait/sleep tool, nothing wakes her, and a 20-40 minute run means either burning turns polling
or Travis relaying the result by hand. A fleet message WAKES an idle agent, so the run can tell
her itself.

Runs at the END of the training command on the TRAINING HOST, so it fires whatever the outcome:
clean finish, non-zero exit, or the trainer dying. It reports the EXIT CODE it was handed rather
than inferring success from artifacts — a run that wrote three checkpoints and then crashed is
not a success, and "weights exist" would call it one.

🛑 IT MUST NEVER FAIL THE RUN. Every path is wrapped and the exit is always 0: a notifier that
breaks a training job because fleetd was down would be worse than no notifier at all.
"""
import argparse
import json
import os
import sys
import urllib.request

FLEETD = os.environ.get("FLEETD_URL", "http://10.0.0.219:17900/send")
TRAINED_ROOT = os.environ.get("LORA_TRAINED_ROOT", "/imagegen/loras/trained")
SENDER = os.environ.get("FLEET_NOTIFY_SENDER", "ai-lab-notifications")


def tail(path, n=40):
    try:
        with open(path, errors="replace") as f:
            return f.read().splitlines()[-n:]
    except OSError:
        return []


def last_progress(lines):
    """The most recent line carrying a step/epoch/loss figure — what a human would look at."""
    best = ""
    for ln in lines:
        low = ln.lower()
        if any(k in low for k in ("loss", "it/s", "steps:", "epoch")):
            # tqdm rewrites one line with \r; keep only the final segment
            best = ln.replace("\r", "\n").split("\n")[-1].strip()[:200]
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--rc", required=True)
    ap.add_argument("--to", required=True, help="fleet agent id")
    a = ap.parse_args()

    # --rc unknown: an EXTERNAL watcher attached to a run it did not spawn, so it cannot read
    # the exit status — Linux gives a non-parent no way to. The verdict is then INFERRED from
    # artifacts and the log tail, and the message says so rather than quietly presenting a
    # guess with the same confidence as a real exit code.
    inferred = False
    try:
        rc = int(a.rc)
    except (TypeError, ValueError):
        inferred = True
        rc = 0

    meta = {}
    try:
        with open(os.path.join(a.run_dir, "job.json")) as f:
            meta = json.load(f)
    except OSError:
        try:
            with open(os.path.join(a.run_dir, "run.json")) as f:
                meta = json.load(f)
        except OSError:
            meta = {}

    run = meta.get("run_id") or os.path.basename(a.run_dir.rstrip("/"))
    name = meta.get("output_name") or run
    trainer = meta.get("trainer") or "?"
    gpu = meta.get("gpu") or meta.get("gpu_index")
    steps = meta.get("steps") or meta.get("epochs")

    # Artifacts are reported as OBSERVATION, never as the verdict — the exit code decides that.
    #
    # 🛑 THE TRAINERS DO NOT SAVE INTO THE RUN DIR. The run dir holds config.yaml and run.json
    # and nothing else; the model lands under the trained root. Looking only in the run dir
    # reported "artifacts: none written" for a run that had just written a 114 MB LoRA and four
    # checkpoints — a SUCCESS rendered as a failure, which is the exact thing this notifier
    # exists to prevent. Two layouts, because the trainers disagree:
    #   ai-toolkit  <trained>/<name>/<name>.safetensors  + <name>_000005000.safetensors ...
    #   kohya       <trained>/<name>.safetensors         + <name>-000002.safetensors ...
    final, ckpts = None, []
    seen = set()
    name = str(meta.get("output_name") or "").strip()
    cands = []
    if name:
        nested = os.path.join(TRAINED_ROOT, name)
        try:
            cands += [(nested, f) for f in os.listdir(nested)]
        except OSError:
            pass
        try:
            cands += [(TRAINED_ROOT, f) for f in os.listdir(TRAINED_ROOT)
                      if f.startswith(name) and os.path.isfile(os.path.join(TRAINED_ROOT, f))]
        except OSError:
            pass
    # The run dir too: the detector-training runs DO write weights/ there.
    for sub in ("", "weights"):
        d = os.path.join(a.run_dir, sub) if sub else a.run_dir
        try:
            cands += [(d, f) for f in os.listdir(d)]
        except OSError:
            pass
    for d, f in cands:
        if not (f.endswith(".safetensors") or f.endswith(".pt")):
            continue
        if f == "optimizer.pt":
            continue                       # trainer state, not a model — saying "3 artifacts"
                                           # when one of them is the optimizer overstates it
        p = os.path.realpath(os.path.join(d, f))
        if p in seen:
            continue                       # the same file can match both layouts
        seen.add(p)
        try:
            sz = os.path.getsize(p)
        except OSError:
            continue
        stem = os.path.splitext(f)[0]
        if name and stem == name:
            final = (f, sz)                # exactly <name> = the finished model
        else:
            ckpts.append(f)

    log = meta.get("log") or os.path.join(a.run_dir, "train.log")
    lines = tail(log)
    prog = last_progress(lines)
    err = ""
    if rc != 0:
        # The last few non-progress lines are where a traceback or CUDA error actually lands.
        err = " | ".join(l.strip()[:160] for l in lines[-6:] if l.strip() and "it/s" not in l)[:600]

    if inferred:
        # No exit status available, so read the evidence: a traceback or CUDA error in the tail
        # is a failure whatever else is on disk; otherwise artifacts mean it produced something.
        bad = any(k in "\n".join(lines).lower()
                  for k in ("traceback", "cuda error", "out of memory", "runtimeerror"))
        ok = bool(final) and not bad     # a checkpoint is not a finished model
        head = ("🟢 LoRA training ENDED — looks SUCCESSFUL (inferred)" if ok
                else "🔴 LoRA training ENDED — looks FAILED (inferred)")
    else:
        ok = rc == 0
        head = ("✅ LoRA training FINISHED" if ok else "❌ LoRA training FAILED (exit %d)" % rc)
    body = [
        "%s — %s" % (head, name),
        "run: %s   trainer: %s%s%s" % (run, trainer,
                                       ("   gpu: %s" % gpu) if gpu is not None else "",
                                       ("   steps/epochs: %s" % steps) if steps else ""),
        ("model: %s (%.1f MB)" % (final[0], final[1] / 1048576.0)) if final
        else ("model: NOT written" + (" — checkpoints exist, so it stopped before the final save"
                                      if ckpts else "")),
        "checkpoints: %s" % ("%d (%s)" % (len(ckpts), ", ".join(sorted(ckpts)[:4])
                                          + (" …" if len(ckpts) > 4 else ""))
                             if ckpts else "none"),
    ]
    if prog:
        body.append("last progress: %s" % prog)
    if err:
        body.append("tail: %s" % err)
    body.append("dir: %s" % a.run_dir)
    if inferred:
        body.append("NOTE: this run was watched from OUTSIDE, so there is no exit code — the "
                    "verdict above is inferred from artifacts and the log tail and could be "
                    "wrong. Confirm with train_lora_status before trusting it.")
    elif not ok:
        body.append("NOTE: exit code is the verdict here, not the artifacts — checkpoints can "
                    "exist for a run that then crashed.")

    payload = {"sender": SENDER, "to": [a.to], "body": "\n".join(body), "kind": "dm"}
    req = urllib.request.Request(FLEETD, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
    except Exception as e:                      # noqa: BLE001 - never fail the training run
        sys.stderr.write("notify_run: could not reach fleetd: %s\n" % e)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:                      # noqa: BLE001
        sys.stderr.write("notify_run: %s\n" % e)
        sys.exit(0)                             # NEVER propagate a notifier failure
