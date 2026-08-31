"""Memory-stack observability contract (Observability Sweep batch 22) — run:
    python3 infra/emitter-tests/memory_stack_test.py

Three surfaces, tested against the REAL shipped code (no copies):

1. unified-memory WriteAheadLog (ast-extracted from server.py — the class is
   pure stdlib; the module's mcp/httpx imports are not installed here):
   compact must NEVER drop unapplied entries; a corrupt WAL line skips, not
   aborts; a corrupt state file degrades in the SAFE direction (everything
   pending, nothing compacted away). Includes a negative control proving the
   harness can see compaction actually dropping lines.

2. hippocampai Hermes provider (real module exec'd with the one non-stdlib
   import — agent.memory_provider — stubbed): corrupt config warns about the
   namespace consequence, prefetch never serves an answer cached for a
   DIFFERENT query, breaker-open drops are counted and read out on recovery,
   and a failed extraction says the turn's memories were lost.

3. hippocampai docker-entrypoint config-layer events (source memory-models):
   diverged embed model → warning; underivable (file yields nothing) →
   warning; agreement → SILENCE. Recorder only, PATH-independent (the script
   is sh + python3).

Out of scope here: server.py's _degraded/WAL-backlog emitters ride the live
module (mcp/httpx deps) — they follow the batch-2 latch already in
production; the wiring is review-verified and exercised on deploy.
"""
import ast
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import types
import http.server

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER = os.path.join(REPO, "infra", "mcp-unified-memory", "mcp_unified_memory", "server.py")
PROVIDER = os.path.join(REPO, "infra", "hermes-memory-provider", "hippocampai", "__init__.py")
ENTRY = os.path.join(REPO, "infra", "docker", "hippocampai", "docker-entrypoint.sh")

n = 0
def ok(cond, msg):
    global n
    if not cond:
        print(f"FAILED: {msg}", file=sys.stderr)
        sys.exit(1)
    n += 1
    print(f"  ok — {msg}")

# ── 1. WriteAheadLog ─────────────────────────────────────────────────────────
src = open(SERVER).read()
tree = ast.parse(src)
cls = next(nd for nd in tree.body if isinstance(nd, ast.ClassDef) and nd.name == "WriteAheadLog")
ns = {"json": json, "os": os, "time": __import__("time"), "Path": __import__("pathlib").Path}
exec(compile(ast.Module(body=[cls], type_ignores=[]), SERVER, "exec"), ns)
WAL = ns["WriteAheadLog"]

tmp = tempfile.mkdtemp(prefix="wal-test-")
w = WAL(os.path.join(tmp, "a"))
ids = []
for i in range(1200):
    # append() derives ids from time-ms; write directly so ids are distinct and ordered
    entry = {"op": "upsert", "memory_id": f"m{i}", "_wal_id": i + 1, "_timestamp": 0}
    with open(w.wal_file, "a") as f:
        f.write(json.dumps(entry) + "\n")
    ids.append(i + 1)
w.mark_applied("fast", 1200)   # fast backend fully caught up
w.mark_applied("slow", 100)    # slow backend 1100 entries behind

pending_before = len(w.get_pending("slow"))
ok(pending_before == 1100, "WAL: slow backend reports its full 1100-entry backlog")
w.compact(keep_last_n=1000)
ok(len(w.get_pending("slow")) == 1100,
   "compact NEVER drops unapplied entries — the slow backend's whole backlog survives")

# negative control: with everyone caught up, compact DOES shrink the file
w2 = WAL(os.path.join(tmp, "b"))
for i in range(1200):
    with open(w2.wal_file, "a") as f:
        f.write(json.dumps({"_wal_id": i + 1}) + "\n")
w2.mark_applied("only", 1200)
w2.compact(keep_last_n=1000)
ok(sum(1 for _ in open(w2.wal_file)) == 1000,
   "negative control: a fully-applied WAL compacts down to keep_last_n (the harness can see dropping)")

# corrupt line: skipped, not fatal to the whole read
with open(w2.wal_file, "a") as f:
    f.write("{corrupt not json\n")
    f.write(json.dumps({"_wal_id": 9001}) + "\n")
ok([e["_wal_id"] for e in w2.get_pending("only")] == [9001],
   "one corrupt WAL line is SKIPPED — the entry after it still reaches pending (old code returned [] here)")

# corrupt state file: everything pending, compact keeps everything (safe direction)
w2.state_file.write_text("{broken")
ok(len(w2.get_pending("only")) == 1001,
   "corrupt state file → ALL entries pending (replay cursor reset, the safe direction)")
w2.compact(keep_last_n=10)
ok(sum(1 for _ in open(w2.wal_file)) == 1002,
   "corrupt state file → compact keeps EVERYTHING, the unparseable line included (floor 0 — loss is impossible while state is unreadable)")
ok(w.min_applied_wal_id() == 100, "min_applied_wal_id is the SLOWEST backend's cursor")

# ── 2. hippocampai provider ──────────────────────────────────────────────────
fake_agent = types.ModuleType("agent"); fake_mp = types.ModuleType("agent.memory_provider")
fake_mp.MemoryProvider = object
fake_agent.memory_provider = fake_mp
sys.modules["agent"] = fake_agent; sys.modules["agent.memory_provider"] = fake_mp
hippo = types.ModuleType("hippo_under_test")
hippo.__file__ = PROVIDER
exec(compile(open(PROVIDER).read(), PROVIDER, "exec"), hippo.__dict__)

log_buf = io.StringIO()
handler = logging.StreamHandler(log_buf)
hippo.logger.addHandler(handler)
hippo.logger.setLevel(logging.DEBUG)

home = tempfile.mkdtemp(prefix="hippo-cfg-")
with open(os.path.join(home, "hippocampai.json"), "w") as f:
    f.write("{not json")
hippo._load_config(home)
ok("DEFAULTS in use" in log_buf.getvalue() and "user_id" in log_buf.getvalue(),
   "corrupt config file warns, naming the wrong-namespace consequence")
log_buf.truncate(0); log_buf.seek(0)
cfg = hippo._load_config(tempfile.mkdtemp(prefix="hippo-empty-"))
ok(log_buf.getvalue() == "" and cfg["url"], "ABSENT config file stays silent — defaults are the configured state")

p = hippo.HippocampAIProvider()
recalls = []
p._recall = lambda q, k: recalls.append(q) or [{"text": f"about {q}"}]
p._format = lambda mems: mems[0]["text"] if mems else ""
p.queue_prefetch("topic A")
import time as _t
for _ in range(100):
    with p._lock:
        if p._prefetched:
            break
    _t.sleep(0.02)
out = p.prefetch("topic B")
ok("about topic A" not in out and "about topic B" in out and recalls[-1] == "topic B",
   "prefetch cached for query A is NOT served to query B — stale answer discarded, honest cold recall runs")
p.queue_prefetch("topic C")
for _ in range(100):
    with p._lock:
        if p._prefetched:
            break
    _t.sleep(0.02)
ok(p.prefetch("topic C") == "about topic C", "matching-query prefetch is served from cache")

# breaker: open it, drop some calls, recover — the bill is read out
p2 = hippo.HippocampAIProvider()
log_buf.truncate(0); log_buf.seek(0)
p2._breaker_until = _t.time() + 60
for _ in range(3):
    ok_none = p2._post("/x", {})
    assert ok_none is None
ok(p2._dropped_while_open == 3, "breaker-open drops are COUNTED, not just swallowed")
p2._breaker_until = 0.0
class _R:
    def read(self): return b"{}"
    def __enter__(self): return self
    def __exit__(self, *a): return False
hippo.urllib.request.urlopen = lambda req, timeout=0: _R()
p2._post("/x", {})
ok("3 calls were dropped" in log_buf.getvalue(),
   "recovery names how many calls the open breaker swallowed")

# failed extraction says the memories were lost
log_buf.truncate(0); log_buf.seek(0)
p3 = hippo.HippocampAIProvider()
p3._post = lambda *a, **k: None
p3._turn_buffer = ["user: hi", "assistant: hello"]
p3._flush_buffer(sync=True)
ok("not captured" in log_buf.getvalue(),
   "a failed extract WARNS that the turn's memories were not captured (the 12-day silent shape)")

# ── 3. entrypoint config-layer events ────────────────────────────────────────
received = []
class Recorder(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        received.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def boot(rag_path, embed_env):
    env = dict(os.environ, RAG_MODELS_FILE=rag_path,
               AILAB_API_URL=f"http://127.0.0.1:{srv.server_address[1]}",
               EMBED_API_MODEL=embed_env, RERANK_API_MODEL="rr")
    return subprocess.run(["sh", ENTRY, "true"], env=env, capture_output=True, text=True, timeout=60)

etmp = tempfile.mkdtemp(prefix="hippo-entry-")
rag = os.path.join(etmp, "rag-models.json")
with open(rag, "w") as f:
    json.dump({"embedModel": "Qwen3-VL-Embedding-8B-FP8", "rerankModel": "rr"}, f)

r = boot(rag, "Qwen3-VL-Embedding-8B")   # diverged: .env pins the retired name
ok(r.returncode == 0, "diverged: boot still succeeds (config events never fail the boot)")
ok(len(received) == 1 and received[0]["severity"] == "warning"
   and received[0]["source"] == "memory-models" and "diverges from .env" in received[0]["message"],
   "diverged embed model → ONE warning on source memory-models")
ok("Qwen3-VL-Embedding-8B-FP8" in received[0]["detail"] and "[host " in received[0]["detail"],
   "the event's detail carries both model names and the host (message stays stable for dedup)")

received.clear()
r = boot(os.path.join(etmp, "nope.json"), "envmodel")   # underivable
ok(len(received) == 1 and received[0]["severity"] == "warning" and "not mounted" in received[0]["message"],
   "missing rag-models.json → warning naming the env fallback drift risk")

received.clear()
r = boot(rag, "Qwen3-VL-Embedding-8B-FP8")   # agreement
ok(r.returncode == 0 and len(received) == 0, "agreement → SILENCE (no event on the normal state)")

print(f"\n{n} assertions passed")
