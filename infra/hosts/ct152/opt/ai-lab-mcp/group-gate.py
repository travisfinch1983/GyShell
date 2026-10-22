"""group-gate: expose ONE MCPJungle tool group on its own port, nothing else.

Why: an MCPJungle tool group is only a view. Any client that can reach :8080 can
also call the full gateway (/mcp: remote shell, vault, memory, ...). The isolated
claude-dhb-enterprise container (CT196, 10.0.0.153) is firewalled away from :8080
and only allowed to reach this port, which forwards exactly one group path.

Usage: python group-gate.py <listen_port> <group_name>
Created 2026-10-22 by claude1.
"""
import sys

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.routing import Route

UPSTREAM = "http://127.0.0.1:8080"
PORT = int(sys.argv[1])
GROUP = sys.argv[2]
ALLOWED = {f"/v0/groups/{GROUP}/mcp", f"/v0/groups/{GROUP}/mcp/"}
HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade"}

client = httpx.AsyncClient(base_url=UPSTREAM, timeout=httpx.Timeout(None, connect=10.0))


async def proxy(request: Request):
    path = request.url.path
    if path not in ALLOWED:
        print(f"[group-gate:{GROUP}] DENIED {request.client.host if request.client else '?'} {request.method} {path}", flush=True)
        return PlainTextResponse("forbidden: only the sitemap tool group is exposed here\n", status_code=403)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    upstream_req = client.build_request(request.method, path, params=request.query_params,
                                        headers=headers, content=await request.body())
    resp = await client.send(upstream_req, stream=True)
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
