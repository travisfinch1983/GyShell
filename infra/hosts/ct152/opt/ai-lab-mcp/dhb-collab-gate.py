"""dhb-collab-gate: allow-list proxy for the INTERNET-EXPOSED coworker container CT190 (dhb-collab,
10.0.0.194) and the shared DHB document store.

Why a separate gate (not group-gate.py :8099): CT190 is reachable from the internet, so it gets the
narrowest possible view of the lab, and it needs things group-gate cannot do — rewriting request
bodies (fleet sender pinning, recipient allow-list, collection scoping) and filtering responses.
The px-nas host fence lets CT190 reach ONLY this port (+ memory server #2 on :9857) on the LAN.

Callers are identified by TCP source IP (CT190 is bridged straight onto vmbr0 and the host fence
drops spoofed sources from its veth):
  10.0.0.194 (CT190 dhb-collab)        fleet (pinned) + DHB doc-RAG read/write + extract LLM
  10.0.0.153 (CT196 dhb-enterprise)    DHB doc-RAG read/write only (its fleet goes direct)

Fleet rules (fleetd itself does NOT authenticate senders — anyone reaching :17900 can claim any
sender — so this gate is what makes "CT190 may only message claude1" true):
  * sender / agent_id / viewer / recipient fields are FORCED to FLEET_AGENT
  * DM recipients must be a subset of FLEET_ALLOWED_RECIPIENTS; nothing else is reachable
  * feed / search / post / visibility / attachments / register / guard are refused
Widening any of this needs Travis's approval (see /root/CLAUDE.md on CT190).

Usage: python dhb-collab-gate.py <listen_port>        Created 2026-11-03 by claude1.
"""
import json
import re
import sys

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, StreamingResponse
from starlette.routing import Route

PORT = int(sys.argv[1])
AILAB = "http://127.0.0.1:17890"
FLEETD = "http://127.0.0.1:17900"

COLLAB_IP = "10.0.0.194"
ENTERPRISE_IP = "10.0.0.153"
FLEET_AGENT = "claude-dhb-collab"
FLEET_ALLOWED_RECIPIENTS = {"claude1", "claude-dhb-enterprise"}
EXTRACT_MODEL = "Qwen3.5-9B-INT8-MM-Thinking-Non_preserved-256k"
RAG_MODELS_FILE = "/opt/ai-lab/.gybackend-data/rag-models.json"

DOCS_COL = re.compile(r"docs_dhb_[a-z0-9_]+")
HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade",
       "content-encoding"}

client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10.0))


def deny(request: Request, why: str, status: int = 403):
    src = request.client.host if request.client else "?"
    print(f"[dhb-collab-gate] DENIED {src} {request.method} {request.url.path} — {why}", flush=True)
    return PlainTextResponse(f"forbidden: {why}\n", status_code=status)


async def forward(request: Request, upstream: str, path: str, *, params=None, body: bytes = None):
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    req = client.build_request(request.method, upstream + path,
                               params=request.query_params if params is None else params,
                               headers=headers,
                               content=await request.body() if body is None else body)
    resp = await client.send(req, stream=True)
    out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in HOP}

    async def stream():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()
    return StreamingResponse(stream(), status_code=resp.status_code, headers=out_headers)


async def fetch_json(method: str, url: str, **kw):
    r = await client.request(method, url, timeout=60.0, **kw)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {"raw": r.text[:500]}


async def json_body(request: Request) -> dict:
    try:
        b = json.loads(await request.body() or b"{}")
        return b if isinstance(b, dict) else {}
    except ValueError:
        return {}


# ── fleet ────────────────────────────────────────────────────────────────────

async def fleet(request: Request, sub: str):
    m = request.method
    q = dict(request.query_params)
    if m == "GET" and sub == "/pending":
        return await forward(request, FLEETD, sub, params={"agent_id": FLEET_AGENT})
    if m == "GET" and sub == "/directory":
        code, d = await fetch_json("GET", FLEETD + sub)
        keep = FLEET_ALLOWED_RECIPIENTS | {FLEET_AGENT}
        d["agents"] = [a for a in d.get("agents", []) if a.get("agent_id") in keep]
        return JSONResponse(d, status_code=code)
    if m == "GET" and re.fullmatch(r"/thread/[A-Za-z0-9_-]+", sub):
        q["viewer"] = FLEET_AGENT
        return await forward(request, FLEETD, sub, params=q)
    if m == "POST" and re.fullmatch(r"/thread/[A-Za-z0-9_-]+/read", sub):
        b = await json_body(request)
        b["viewer"] = FLEET_AGENT
        return await forward(request, FLEETD, sub, body=json.dumps(b).encode())
    if m == "POST" and sub in ("/heartbeat", "/turn"):
        b = await json_body(request)
        b["agent_id"] = FLEET_AGENT
        return await forward(request, FLEETD, sub, body=json.dumps(b).encode())
    if m == "POST" and sub in ("/delivered", "/ack"):
        b = await json_body(request)
        b["recipient"] = FLEET_AGENT
        return await forward(request, FLEETD, sub, body=json.dumps(b).encode())
    if m == "POST" and sub == "/send":
        b = await json_body(request)
        if b.get("kind", "dm") != "dm":
            return deny(request, "only direct messages are allowed from this instance")
        to = [t for t in (b.get("to") or []) if t]
        if not to and b.get("thread_id"):
            # A reply into a thread with no `to` would go to EVERY participant — resolve it here
            # and keep only the allowed ones, so a thread claude1 widened cannot widen this sender.
            code, th = await fetch_json("GET", f"{FLEETD}/thread/{b['thread_id']}",
                                        params={"viewer": FLEET_AGENT, "limit": "1"})
            if code != 200:
                return JSONResponse(th, status_code=code)
            parts = (th.get("thread") or {}).get("participants") or []
            if isinstance(parts, str):
                parts = json.loads(parts)
            to = [p for p in parts if p in FLEET_ALLOWED_RECIPIENTS]
        elif b.get("thread_id"):
            # The adapter fills `to` with every other thread participant; on a thread someone
            # else widened, reply only to the allowed ones rather than failing the whole reply.
            to = [t for t in to if t in FLEET_ALLOWED_RECIPIENTS]
        bad = [t for t in to if t not in FLEET_ALLOWED_RECIPIENTS]
        if bad or not to:
            return deny(request, f"this instance may only message {sorted(FLEET_ALLOWED_RECIPIENTS)}"
                                 f" (asked for {bad or 'nobody'}); ask claude1 if you need more")
        b.update({"sender": FLEET_AGENT, "to": to, "kind": "dm"})
        return await forward(request, FLEETD, sub, body=json.dumps(b).encode())
    return deny(request, f"fleet {m} {sub} is not available to this instance")


# ── document RAG (shared DHB store) ──────────────────────────────────────────

async def docrag_manifest():
    code, d = await fetch_json("GET", AILAB + "/api/ai/docrag/collections")
    return d if code == 200 and isinstance(d, list) else []


async def docs(request: Request, path: str):
    m = request.method
    if m == "POST" and path == "/api/proxy/embed/v1/embeddings":
        return await forward(request, AILAB, path)
    if m == "GET" and path == "/dhb/rag-models":
        # The embed model is chosen once in AI-Lab (rag-models.json); remote dhb-docs servers must
        # embed queries with the SAME model as the corpus, so they read it here, never a hardcode.
        try:
            with open(RAG_MODELS_FILE) as f:
                return JSONResponse({"embedModel": (json.load(f) or {}).get("embedModel", "")})
        except (OSError, ValueError) as e:
            return JSONResponse({"error": f"rag-models.json unreadable: {e}"}, status_code=503)

    mt = re.fullmatch(r"/api/proxy/vector/all/collections/([a-z0-9_]+)(/search|/keyword-search|/count)?", path)
    if mt:
        col, op = mt.group(1), mt.group(2) or ""
        if not DOCS_COL.fullmatch(col):
            return deny(request, "only docs_dhb_* collections")
        if (op in ("/search", "/keyword-search") and m == "POST") or (op in ("", "/count") and m == "GET"):
            return await forward(request, AILAB, path)
        return deny(request, "read-only vector access")

    if m == "GET" and path == "/api/ai/docrag/collections":
        return JSONResponse([c for c in await docrag_manifest() if DOCS_COL.fullmatch(c.get("name", ""))])

    md = re.fullmatch(r"/api/ai/docrag/collections/([a-z0-9_]+)/(documents|stats)", path)
    if md and m == "GET":
        if not DOCS_COL.fullmatch(md.group(1)):
            return deny(request, "only docs_dhb_* collections")
        return await forward(request, AILAB, path)

    if m == "GET" and path == "/api/ai/docrag/page-image":
        if not DOCS_COL.fullmatch(request.query_params.get("collection", "")):
            return deny(request, "only docs_dhb_* collections")
        return await forward(request, AILAB, path)

    if m == "GET" and path == "/api/ai/docrag/index/status":
        code, st = await fetch_json("GET", AILAB + path)
        if not DOCS_COL.fullmatch(str(st.get("colName") or "")) and not str(st.get("collection") or "").startswith(("dhb_", "docs_dhb_")):
            # Another (lab) job: say the indexer is busy/idle, never what it is indexing.
            st = {"active": st.get("active", False), "phase": "other-job" if st.get("active") else st.get("phase"),
                  "note": "the indexer is shared; a non-DHB job is running or last ran"}
        return JSONResponse(st, status_code=code)

    if m == "POST" and path == "/api/ai/docrag/index-b64":
        b = await json_body(request)
        raw = str(b.get("collection") or "").strip().lower()
        base = raw[5:] if raw.startswith("docs_") else raw
        if not re.fullmatch(r"dhb_[a-z0-9_]+", base):
            return deny(request, "collection must be named dhb_<something> (stored as docs_dhb_<something>)")
        names = {c.get("name") for c in await docrag_manifest()}
        # rag.js uses the name as-is when it is already in the manifest, else prefixes docs_ —
        # so an existing collection must be sent with its docs_ name, a new one without.
        b["collection"] = f"docs_{base}" if f"docs_{base}" in names else base
        return await forward(request, AILAB, path, body=json.dumps(b).encode())

    return None


# ── LLM (memory-extract hook only) ───────────────────────────────────────────

async def llm(request: Request):
    b = await json_body(request)
    b["model"] = EXTRACT_MODEL   # pinned: this path exists for the memory-extract hook, not general use
    return await forward(request, AILAB, request.url.path, body=json.dumps(b).encode())


async def handler(request: Request):
    src = request.client.host if request.client else ""
    path = request.url.path
    if ".." in path:
        return deny(request, "bad path")
    if src not in (COLLAB_IP, ENTERPRISE_IP):
        return deny(request, "source not allowed")
    if path.startswith("/fleet/"):
        if src != COLLAB_IP:
            return deny(request, "fleet via this gate is for CT190 only")
        return await fleet(request, path[len("/fleet"):])
    if path == "/api/proxy/llm/v1/chat/completions" and request.method == "POST":
        if src != COLLAB_IP:
            return deny(request, "not on the allow-list")
        return await llm(request)
    r = await docs(request, path)
    return r if r is not None else deny(request, "not on the dhb-collab allow-list")


app = Starlette(routes=[Route("/{p:path}", handler, methods=["GET", "POST", "DELETE", "PUT", "PATCH"])])

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
