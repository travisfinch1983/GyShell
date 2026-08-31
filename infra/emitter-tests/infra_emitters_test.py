"""Infra emitter tests — run: python3 infra/tests/infra_emitters_test.py

Fires the batch-15 emitters against a local recorder: the GPU exporter's
nvidia-smi failure counter + latch (counting EXISTING calls only — the standing
deadlock rule forbids new call sites), provision_all's /emit (host-named, with
the NOTIFY LOST stderr fallback), and the drift-check script end-to-end on real
temp trees (per-script events, reverse drift, silence when clean).

Committed rather than scratch: an uncommitted verification is a claim, not an
artifact. No live host, no live board — recorder only.
"""
import http.server, json, os, subprocess, sys, threading, importlib, types
received = []
class Rec(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        received.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Rec)
threading.Thread(target=srv.serve_forever, daemon=True).start()
api = f"http://127.0.0.1:{srv.server_address[1]}"
os.environ["AILAB_API_URL"] = api

n = 0
def ok(c, m):
    global n
    if not c: raise SystemExit(f"FAILED: {m}\n{json.dumps(received, indent=1)[:600]}")
    n += 1; print("  ok —", m)

# ── exporter: counter + latch, via the real module with run() driven ──────────
sys.path.insert(0, "/root/repos/ai-lab-fable/infra/service-gpu-exporter")
import service_gpu_exporter as ex
ex.AILAB_API = api
# a non-nvidia command failing must NOT count (the counter is nvidia-scoped)
ex.run(["/bin/false"])
ok(ex.NVSMI_ERRORS == 0, "non-nvidia command failures do not touch the counter")
# nvidia-smi absent here → the except path counts it (an EXISTING call failing)
before = ex.NVSMI_ERRORS
ex.run(["nvidia-smi", "--query-gpu=uuid", "--format=csv"])
ok(ex.NVSMI_ERRORS == before + 1, "a failing nvidia-smi call increments the counter — failure is no longer idle")
# latch: two failing scrape passes silent, third fires once, clean pass re-arms
import time
for i in range(2):
    ex._emit_degraded("d")
time.sleep(0.2)
ok(len(received) == 0, "two failing passes: silent (latch threshold 3)")
ex._emit_degraded("d"); time.sleep(0.3)
ok(len(received) == 1 and received[0]["source"] == "gpu-exporter", "third fires ONE gpu-exporter warning")
ok("[host " in received[0]["detail"], "and the event NAMES THE HOST it ran on")
ex._emit_degraded("d"); time.sleep(0.2)
ok(len(received) == 1, "latched while failing")
ex._emit_rearm()
for i in range(3): ex._emit_degraded("d")
time.sleep(0.3)
ok(len(received) == 2, "a clean pass re-arms — a new outage reports again")

# ── provision_all emit(): host named, lost-report fallback ────────────────────
received.clear()
sys.path.insert(0, "/root/repos/ai-lab-fable/mcp-servers/ailab-pages")
os.environ["AILAB_API_URL"] = api
import importlib.util
spec = importlib.util.spec_from_file_location("prov", "/root/repos/ai-lab-fable/mcp-servers/ailab-pages/provision_all.py")
prov = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(prov)  # module-level only; main() not called
except SystemExit:
    pass
prov.API = api
prov.emit("error", "test failure", "details here")
time.sleep(0.2)
ok(len(received) == 1 and received[0]["source"] == "mcp-provision" and "[host " in received[0]["detail"],
   "provision_all emit reaches the panel with the HOST named")
prov.API = "http://127.0.0.1:9"
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    prov.emit("error", "lost one", "d")
ok("NOTIFY LOST" in buf.getvalue(), "a lost report leaves a NOTIFY LOST line, never silence")

# ── drift-check script: per-script events, host named, clean = silent ─────────
received.clear()
import tempfile, pathlib
repo = tempfile.mkdtemp(); dest = tempfile.mkdtemp()
pathlib.Path(repo, "a.sh").write_text("echo new version\nline2\n")
pathlib.Path(dest, "a.sh").write_text("echo old\n")
pathlib.Path(repo, "b.sh").write_text("same\n")
pathlib.Path(dest, "b.sh").write_text("same\n")
pathlib.Path(dest, "orphan.sh").write_text("hand-edited live\n")
env = dict(os.environ, AILAB_API_URL=api, AILAB_PROVIDER_REPO=repo, AILAB_DATA_DIR=dest)
# the script derives DEST as $AILAB_DATA_DIR/scripts/providers — build that layout
real_dest = pathlib.Path(dest, "scripts", "providers"); real_dest.mkdir(parents=True)
for f in ["a.sh", "orphan.sh", "b.sh"]:
    pathlib.Path(dest, f).rename(real_dest / f)
r = subprocess.run(["bash", "/root/repos/ai-lab-fable/infra/provider-scripts/drift-check/provider-drift-check.sh"],
                   env=env, capture_output=True, text=True, timeout=30)
time.sleep(0.3)
msgs = [e["message"] for e in received]
ok(any("drifted from the repo" in m for m in msgs), "a drifted script raises its own event")
ok(any("no repo source" in m for m in msgs), "a deployed-only script raises reverse-drift")
ok(all("[host " in e["detail"] for e in received), "every drift event names the host")
ok(not any("b.sh" in e["detail"] for e in received), "an identical script raises nothing")
count = len(received)
# clean tree: silent
pathlib.Path(repo, "a.sh").write_text((real_dest / "a.sh").read_text())
pathlib.Path(repo, "orphan.sh").write_text((real_dest / "orphan.sh").read_text())
r2 = subprocess.run(["bash", "/root/repos/ai-lab-fable/infra/provider-scripts/drift-check/provider-drift-check.sh"],
                    env=env, capture_output=True, text=True, timeout=30)
time.sleep(0.3)
ok(len(received) == count and "OK" in r2.stdout, "a clean tree emits NOTHING — silence when healthy")

print(f"\n{n} assertions passed")
