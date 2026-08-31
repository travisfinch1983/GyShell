"""OpenViking entrypoint refuse-loudly contract — run:
    python3 infra/emitter-tests/openviking_entrypoint_test.py

Drives the REAL docker-entrypoint.sh end to end (openviking-server stubbed on
PATH) through all four cases of claude1's ruling:
  1. substitution + NO existing workspace → boots DEGRADED against a read-only
     quarantine dir (writes fail visibly), one critical, README present
  2. substitution + workspace EXISTS → CONTINUES it (established identity, not
     a new one), one warning
  3. configured model served → normal boot, NOTHING emitted
  4. fingerprint probe fails → refuses (exit 1), one critical

The old behaviour silently substituted and mkdir'd a fresh EMPTY workspace —
boots healthy, zero memories: it traded a 4149-restart crash-loop for silent
total memory loss. Substitution may CONTINUE an identity, never CREATE one.

Recorder + stub /models only — no live board, no live container. PATH is
pinned to /usr/bin:/bin inside the runs so a fancy interactive `ls` cannot
corrupt anything (that exact artifact broke this harness's first version).
"""
import http.server
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(REPO, "infra", "docker", "openviking", "docker-entrypoint.sh")

n = 0
def ok(cond, msg):
    global n
    if not cond:
        print(f"FAILED: {msg}", file=sys.stderr)
        sys.exit(1)
    n += 1
    print(f"  ok — {msg}")

received = []
class Recorder(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        received.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass

serve_models = True
class Models(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if not serve_models:
            self.send_response(500); self.end_headers(); return
        body = json.dumps({"data": [{"id": "NewModel-FP8", "root": "/models/new"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

rec_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
mod_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Models)
threading.Thread(target=rec_srv.serve_forever, daemon=True).start()
threading.Thread(target=mod_srv.serve_forever, daemon=True).start()
REC_PORT = rec_srv.server_address[1]
MOD_PORT = mod_srv.server_address[1]

tmp = tempfile.mkdtemp(prefix="ov-entry-")
bin_dir = os.path.join(tmp, "bin")
os.makedirs(bin_dir)
stub = os.path.join(bin_dir, "openviking-server")
with open(stub, "w") as f:
    f.write("#!/bin/sh\necho STUB-SERVER\nexit 0\n")
os.chmod(stub, 0o755)

conf_sub = os.path.join(tmp, "ov.conf")        # names a model the stub does NOT serve
with open(conf_sub, "w") as f:
    json.dump({"embedding": {"dense": {"api_base": f"http://127.0.0.1:{MOD_PORT}", "model": "OldModel-GONE"}},
               "vlm": {"model": "x"}}, f)
conf_ok = os.path.join(tmp, "ov-ok.conf")      # names the served model
with open(conf_ok, "w") as f:
    json.dump({"embedding": {"dense": {"api_base": f"http://127.0.0.1:{MOD_PORT}", "model": "NewModel-FP8"}},
               "vlm": {"model": "x"}}, f)

def run(conf, root):
    os.makedirs(root, exist_ok=True)
    env = dict(os.environ,
               PATH=f"{bin_dir}:/usr/bin:/bin",
               OV_CONFIG=conf, OV_WORKSPACE_ROOT=root,
               AILAB_API_URL=f"http://127.0.0.1:{REC_PORT}")
    return subprocess.run(["sh", SCRIPT], env=env, capture_output=True, text=True, timeout=60)

# ── case 1: substitution, no existing workspace → quarantine ─────────────────
ws1 = os.path.join(tmp, "ws1")
r = run(conf_sub, ws1)
ok(r.returncode == 0 and "STUB-SERVER" in r.stdout, "case 1: the service BOOTS (degraded beats down)")
quar = [d for d in os.listdir(ws1) if d.startswith("UNRESOLVED-DO-NOT-USE-")]
ok(len(quar) == 1, "case 1: workspace is the labelled quarantine dir — a real one was NOT created")
qpath = os.path.join(ws1, quar[0])
ok(os.path.exists(os.path.join(qpath, "README-UNRESOLVED.txt")), "case 1: the README explains the repair in place")
ok(not os.stat(qpath).st_mode & stat.S_IWUSR, "case 1: quarantine is READ-ONLY — every capture write fails visibly")
ok(len(received) == 1 and received[0]["severity"] == "critical"
   and "WITHOUT its memory workspace" in received[0]["message"],
   "case 1: one CRITICAL raised, saying the service runs without its workspace")
ok("[host " in received[0]["detail"], "case 1: the event names the host")
fp = quar[0].replace("UNRESOLVED-DO-NOT-USE-", "")

# ── case 2: substitution, workspace EXISTS → continue ────────────────────────
ws2 = os.path.join(tmp, "ws2")
os.makedirs(os.path.join(ws2, fp))
open(os.path.join(ws2, fp, "existing-memories.bin"), "w").close()
r = run(conf_sub, ws2)
ok(r.returncode == 0 and "CONTINUING" in r.stderr, "case 2: an EXISTING workspace is continued — identity established, not manufactured")
ok(received[-1]["severity"] == "warning" and "existing workspace continued" in received[-1]["message"],
   "case 2: one WARNING (names should agree), not a critical")

# ── case 3: model matches → silence ──────────────────────────────────────────
before = len(received)
r = run(conf_ok, os.path.join(tmp, "ws3"))
ok(r.returncode == 0 and "STUB-SERVER" in r.stdout, "case 3: normal boot")
ok(len(received) == before, "case 3: NOTHING emitted on the normal state")

# ── case 4: probe fails → refuse, loudly ─────────────────────────────────────
serve_models = False
r = run(conf_sub, os.path.join(tmp, "ws4"))
ok(r.returncode == 1, "case 4: unfingerprintable model REFUSES to start (exit 1)")
ok(received[-1]["severity"] == "critical" and "refused to start" in received[-1]["message"],
   "case 4: and the refusal is a critical event, not just a crash-loop in journald")

print(f"\n{n} assertions passed")
