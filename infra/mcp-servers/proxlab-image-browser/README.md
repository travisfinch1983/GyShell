# proxlab-image-browser MCP server

Deployed at `/opt/mcp-proxlab-image-browser/server.py` on **CT152 (10.0.0.219)**, which is NOT
version controlled — this is the tracked copy. Spawned by MCPJungle over stdio with
`/opt/mcp-proxlab-cluster/.venv/bin/python`.

31 tools: image browsing/curation, cropping, rating, captioning, training batches, LoRA training.

## Deploying a change

    scp server.py root@10.0.0.219:/opt/mcp-proxlab-image-browser/server.py
    ssh root@10.0.0.219 '/opt/mcp-proxlab-image-browser/check_scope.py'
    ssh root@10.0.0.219 'cd /opt/ai-lab-mcp && ./mcpjungle register -c /tmp/ib-register.json --force'
    # then, for each live agent that needs them:
    curl -X POST http://127.0.0.1:17890/api/hermes/agents/<id>/tool-reconnect

## 🛑 THREE TRAPS, ALL HIT FOR REAL (2026-09-02)

1. **The entry point must stay LAST.** `mcp.run()` blocks, so anything defined below it never
   executes when the module runs as a server. Nine tools appended after it were importable,
   individually callable, and completely absent from `tools/list`. The file said 31 and the
   server said 22.
2. **Importing the module is NOT running it.** `__name__ != "__main__"` on import, so `mcp.run()`
   is skipped and the whole file executes — an import-based test passes while the server is
   broken. Probe with a real stdio `tools/list` handshake instead.
3. **MCPJungle caches tool schemas at registration.** Restarting the server surfaces nothing.
   Re-register with `--force`, verify THROUGH THE GATEWAY (not the server), then tool-reconnect
   any live agent — a running session captured its toolset at creation.

## Path scoping

`_scope()` makes the `training_images/` prefix optional on every path argument. Run
`check_scope.py` after ANY edit: it asserts every path-bearing backend call goes through
`_scope()`, and exits 2 (not 0) if its own regex stops matching, so it cannot pass vacuously.

## Training tools

Runs execute on **ai-epyc (10.0.0.234)** over SSH, detached with `setsid` — a training run
outlives any tool call by hours. State lives in `/imagegen/lora_runs/<run_id>/` on the shared
mount so both hosts see it. `train_lora_stop` kills the process **group**: accelerate spawns
children, and killing only the parent strands the GPU.

`train_lora` refuses rather than warns — missing batch, empty batch, or any image without a
`.txt` sidecar. An unlabeled image trains as noise and degrades the LoRA silently, so it is
better caught before a multi-hour run than after.

**AI Toolkit / Krea 2 is BLOCKED**, deliberately. The install is real
(`/opt/ai-toolkit`, conda env `ai-toolkit`, `python run.py <config.yaml>`) but the checkout is
from 2026-03-28 and its model registry has no Krea architecture, so Krea 2 fails at model load.
`aitoolkit_status()` reports this; `train_lora(trainer='aitoolkit')` refuses with the reason.
Enabling it means updating a live training rig — a decision, not a side effect.
