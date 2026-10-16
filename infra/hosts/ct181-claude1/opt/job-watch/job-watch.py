#!/usr/bin/env python3
"""job-watch — notify on Telegram when a declared long-running job finishes.

WHY THIS EXISTS (2026-08-22): Travis had to prompt me FOUR times for status on
benchmark legs that had already completed — twice within 40 minutes of finishing.
Intending to check back does not work; a long job needs to announce itself.

A job is a shell predicate. When it flips from running -> not running, or a
declared output file appears, we Telegram. State is on disk so a restart or a
context compaction cannot lose it.

Config: /opt/job-watch/jobs.json
  [{"name": "...", "host": "10.0.0.235",
    "running_check": "pgrep -f runleg", "done_file": "/path/to/out.json",
    "note": "what to say when it finishes"}]
"""
import json, os, subprocess, sys, time, urllib.parse, urllib.request

CONFIG = "/opt/job-watch/jobs.json"
STATE = "/var/lib/job-watch/state.json"
KEY = "/root/claude_key"


def log(m):
    print(f"{time.strftime('%H:%M:%S')} {m}", flush=True)


def telegram(text):
    """Notify Travis. Name kept for the call sites; it now posts to his Matrix DM with claude1
    via /usr/local/bin/matrix-notify (Telegram retired 2026-10-16)."""
    import subprocess
    try:
        r = subprocess.run(["/usr/local/bin/matrix-notify"], input=text[:30000], text=True,
                           capture_output=True, timeout=90)
    except Exception as e:  # noqa: BLE001
        log(f"matrix-notify failed to run: {e}"); return False
    if r.returncode != 0:
        log(f"matrix-notify failed: {r.stderr.strip()[:300]}"); return False
    return True

def inbox(text):
    """Also drop the notice in claude1's durable inbox.

    telegram() only sends OUTBOUND to Travis -- it cannot wake this session, so on
    its own it just recreates the "nobody notices until Travis asks" problem that
    job-watch exists to solve. The inbox is the channel that actually reaches the
    agent's next turn, and it survives restarts and compaction.
    """
    d = "/var/lib/fleet-forwarder/inbox"
    try:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "claude1.jsonl"), "a") as fh:
            fh.write(json.dumps({
                "from": "job-watch", "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "busSeq": None, "body": text, "read": False}) + "\n")
        return True
    except OSError as e:
        log(f"ERROR inbox write: {e}")
        return False


def remote(host, cmd, timeout=30):
    """Run a command on a remote host. Returns (rc, stdout)."""
    try:
        p = subprocess.run(
            ["ssh", "-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
             "-o", "ConnectTimeout=10", f"root@{host}", cmd],
            capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "").strip()
    except Exception as e:
        log(f"ERROR ssh {host}: {e}")
        return 255, ""


def main():
    try:
        jobs = json.load(open(CONFIG))
    except (OSError, ValueError) as e:
        log(f"no/invalid config ({e}) — nothing to watch"); return 0
    if not jobs:
        log("no jobs configured"); return 0
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}

    changed = False
    for j in jobs:
        name = j.get("name")
        host = j.get("host")
        if not name or not host:
            log(f"malformed job entry, skipping: {j!r}"); continue
        prev = state.get(name, {})
        if prev.get("announced"):
            continue

        rc, out = remote(host, f"{j['running_check']} >/dev/null 2>&1 && echo RUNNING || echo IDLE")
        running = (out == "RUNNING")
        seen_running = prev.get("seen_running", False) or running

        done = False
        if j.get("done_file"):
            rc2, out2 = remote(host, f"test -f {j['done_file']} && stat -c %Y {j['done_file']} || echo 0")
            mtime = int(out2 or 0)
            done = mtime > int(prev.get("baseline_mtime", 0))
            prev["last_mtime"] = mtime
        if not prev.get("baseline_mtime"):
            prev["baseline_mtime"] = prev.get("last_mtime", 0)

        prev["seen_running"] = seen_running
        state[name] = prev
        changed = True

        # Finished = we saw it running and it now isn't, or its output appeared.
        if (seen_running and not running) or done:
            msg = (f"✅ JOB FINISHED: {name}\n\n{j.get('note','')}\n\n"
                   f"host {host}" + (f"\noutput: {j['done_file']}" if j.get("done_file") else ""))
            inbox(msg)
            if telegram(msg):
                prev["announced"] = True
                log(f"ANNOUNCED {name}")
            else:
                log(f"could not announce {name} — will retry next tick")
        else:
            log(f"{name}: running={running} seen_running={seen_running}")

    if changed:
        tmp = STATE + ".tmp"
        try:
            with open(tmp, "w") as fh:
                json.dump(state, fh, indent=2)
            os.replace(tmp, STATE)
        except OSError as e:
            log(f"ERROR persisting state: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
