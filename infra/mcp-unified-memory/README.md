# mcp-unified-memory — the lab's single `memory` MCP server

Source of record for the code deployed at `/opt/mcp-unified-memory` on CT152
(10.0.0.219) and run by the `ai-lab-memory-mcp` systemd unit on port **9847**.

## What it is

One MCP server, five backends: writes replicate to Qdrant / Weaviate / ChromaDB
(shared `unified_memory` collection) **and** HippocampAI (10.0.0.26:8000);
recalls fan out to all of them, merge with Reciprocal Rank Fusion, and rerank
through the proxlab cross-encoder. A file WAL replays writes to any vector DB
that was down. Nine tools: remember / recall / search_memories / delete_memory /
memory_health / extract_facts / collection_store / collection_search /
collection_list.

## Consolidation (2026-07-07)

This service replaced three separate mcpjungle registrations:

| old registration | what it was | where it went |
|---|---|---|
| `memory` | npx `@modelcontextprotocol/server-memory` (stray knowledge-graph demo) | deregistered, manifest retired |
| `unified-memory` | this code over stdio, spawned by the gateway | renamed → `memory`, now streamable HTTP to :9847 |
| `hippocampai-claude` | separate stdio server talking only to HippocampAI | collapsed — this server already writes/reads HippocampAI as one of its backends |

Gateway groups `agent-main` / `agent-professor` / `agent-reporter` were rewired
from `unified-memory__*` to `memory__*` tool names. Retired manifests live in
`/opt/ai-lab-mcp/servers/.retired-2026-07-07/` on CT152.

## Per-caller namespacing — the whole point

The server routes every memory to a **user namespace** with zero per-call
ceremony:

- `POST http://10.0.0.219:9847/mcp` → the shared default namespace
  (`HIPPOCAMPAI_USER`, historically `claude`). This is what the mcpjungle
  gateway registration points at.
- `POST http://10.0.0.219:9847/u/<name>/mcp` → namespace `<name>`. Same
  process, same tools; a tiny ASGI wrapper parses the path prefix into a
  contextvar and every tool falls back to it when no explicit `user_id`
  argument is passed. Stateless HTTP, so each request carries its identity —
  agents-as-users with **no per-caller server instances**.

Recall isolation: HippocampAI scopes natively by `user_id`; the vector DBs
share one collection, so `consensus_recall` filters each DB's hits by the
`user_id` stamped in the write payload. Legacy entries written before the
consolidation carry no `user_id` and are attributed to the historical shared
default (`claude`).

An explicit `user_id` argument on any tool still overrides both defaults.

## Files

- `mcp_unified_memory/` — the package (`server.py`, `__main__.py`). stdio mode
  by default; `--http` or `MEMORY_MCP_HTTP_PORT` selects streamable HTTP.
- `ai-lab-memory-mcp.service` — the CT152 systemd unit.
- `memory.manifest.json` — copy of `/opt/ai-lab-mcp/servers/memory.json`.

Env knobs: `MEMORY_MCP_HTTP_PORT` (9847), `MEMORY_MCP_ALLOWED_HOSTS` (extra
Host-header allowlist for the DNS-rebinding guard; the box's LAN IP is the
default), `HIPPOCAMPAI_URL`/`HIPPOCAMPAI_USER`, `PROXLAB_URL` (embed+rerank),
`COLLECTION_NAME`, `EMBED_MODEL`, `EMBED_DIM`, `WAL_DIR`.

## Deploy

```sh
rsync -a mcp_unified_memory/ root@10.0.0.219:/opt/mcp-unified-memory/mcp_unified_memory/
cp ai-lab-memory-mcp.service /etc/systemd/system/   # on CT152
systemctl daemon-reload && systemctl restart ai-lab-memory-mcp
```
