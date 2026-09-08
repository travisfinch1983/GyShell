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

    try:
        rc = int(a.rc)
    except (TypeError, ValueError):
        rc = -1

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
    ckpts = []
    for sub in ("", "weights"):
        d = os.path.join(a.run_dir, sub) if sub else a.run_dir
        try:
            ckpts += [f for f in os.listdir(d) if f.endswith(".safetensors") or f.endswith(".pt")]
        except OSError:
            pass

    log = meta.get("log") or os.path.join(a.run_dir, "train.log")
    lines = tail(log)
    prog = last_progress(lines)
    err = ""
    if rc != 0:
        # The last few non-progress lines are where a traceback or CUDA error actually lands.
        err = " | ".join(l.strip()[:160] for l in lines[-6:] if l.strip() and "it/s" not in l)[:600]

    ok = rc == 0
    head = ("✅ LoRA training FINISHED" if ok else "❌ LoRA training FAILED (exit %d)" % rc)
    body = [
        "%s — %s" % (head, name),
        "run: %s   trainer: %s%s%s" % (run, trainer,
                                       ("   gpu: %s" % gpu) if gpu is not None else "",
                                       ("   steps/epochs: %s" % steps) if steps else ""),
        "artifacts: %s" % (", ".join(sorted(ckpts)[:8]) + ("  (+%d more)" % (len(ckpts) - 8) if len(ckpts) > 8 else "")
                           if ckpts else "none written"),
    ]
    if prog:
        body.append("last progress: %s" % prog)
    if err:
        body.append("tail: %s" % err)
    body.append("dir: %s" % a.run_dir)
    if not ok:
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
