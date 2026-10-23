"""group-gate: a tiny allow-list proxy for the isolated claude-dhb-enterprise container.

Why: an MCPJungle tool group is only a VIEW. Any client that can reach :8080 can also call the
full gateway (/mcp: remote shell, vault, memory, ...), and anything that can reach the AI-Lab API
(:17890) can drive the whole lab. The isolated CT196 (sitemap, 10.0.0.153) is firewalled away from
both and may only reach this port, which forwards an explicit list of paths and 403s the rest.

Usage: python group-gate.py <listen_port>
Created 2026-10-22 by claude1.
"""
import re
import sys

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.routing import Route

PORT = int(sys.argv[1])
MCPJUNGLE = "http://127.0.0.1:8080"
AILAB = "http://127.0.0.1:17890"
GITEA = "http://10.0.0.146:3000"
# (match, kind, upstream). kind "exact" or "prefix". Keep this list SHORT and specific.
RULES = [
    ("/v0/groups/sitemap-enterprise/mcp", "exact", MCPJUNGLE),        # the curated MCP tool group
    ("/v0/groups/sitemap-enterprise/mcp/", "exact", MCPJUNGLE),
    ("/api/proxy/stt/v1/audio/transcriptions", "exact", AILAB),       # matrix plugin voice notes
    ("/api/proxy/multi-tts/v1/audio/speech", "exact", AILAB),          # matrix plugin voice replies
    ("/api/proxy/llm/v1/", "prefix", AILAB),                           # SiteMap photo validation (VLM)
    ("/api/proxy/embed/v1/", "prefix", AILAB),                         # SiteMap RAG embeddings (Qwen3-VL-Embedding-8B, 4096-d)
    ("/api/ai/docrag/page-image", "exact", AILAB),                     # document-rag-dhb page-image links; GET + docs_dhb_* only (QUERY_RULES)
    # git smart-HTTP for the Blattner repos ONLY (Gitea has public lab repos; no direct access)
    ("/claude/sitemap.git/", "prefix", GITEA),
    ("/claude/sitemap-infra.git/", "prefix", GITEA),
    ("/claude/whiteboard.git/", "prefix", GITEA),
    ("/claude/workspace.git/", "prefix", GITEA),
]
# Paths whose QUERY must also pass: page images are served for any collection, so the gate pins
# them to the dhb_* collections that document-rag-dhb exposes (GET only).
QUERY_RULES = {
    "/api/ai/docrag/page-image": lambda req: req.method == "GET"
        and re.fullmatch(r"docs_dhb_[a-z0-9_]+", req.query_params.get("collection", "")) is not None,
}
HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade"}
clients = {u: httpx.AsyncClient(base_url=u, timeout=httpx.Timeout(None, connect=10.0)) for u in {MCPJUNGLE, AILAB, GITEA}}


def route_for(path: str):
    for match, kind, up in RULES:
        if (kind == "exact" and path == match) or (kind == "prefix" and path.startswith(match)):
            return up
    return None


async def proxy(request: Request):
    path = request.url.path
    up = route_for(path)
    qrule = QUERY_RULES.get(path)
    if not up or ".." in path or (qrule and not qrule(request)):
        print(f"[group-gate] DENIED {request.client.host if request.client else '?'} {request.method} {path}", flush=True)
        return PlainTextResponse("forbidden: not on the sitemap allow-list\n", status_code=403)
    client = clients[up]
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    req = client.build_request(request.method, path, params=request.query_params,
                               headers=headers, content=await request.body())
    resp = await client.send(req, stream=True)
    out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in HOP}

    async def body():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()

    return StreamingResponse(body(), status_code=resp.status_code, headers=out_headers)


app = Starlette(routes=[Route("/{p:path}", proxy, methods=["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"])])

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
