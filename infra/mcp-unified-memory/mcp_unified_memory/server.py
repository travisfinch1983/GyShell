"""
Unified RAG Memory MCP Server

Writes to ALL vector DBs simultaneously (Qdrant, Milvus, Weaviate, ChromaDB)
AND to HippocampAI. Reads from all sources with consensus search + Nemotron
reranking. HippocampAI acts as a "smart" source with its own BM25 + reranking
pipeline, while the other DBs provide redundancy.

Graceful degradation: if any DB is down, operations continue with the rest.
A write-ahead log tracks writes so offline DBs can be synced when they recover.
"""

import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP

# ─── Configuration ───────────────────────────────────────────────────────────

PROXLAB_URL = os.environ.get("PROXLAB_URL", "http://10.0.0.140:7777")
HIPPOCAMPAI_URL = os.environ.get("HIPPOCAMPAI_URL", "http://10.0.0.26:8000")
HIPPOCAMPAI_USER = os.environ.get("HIPPOCAMPAI_USER", "claude")

# Per-caller namespace routing (memory consolidation, 2026-07-07): in HTTP
# mode the ASGI middleware parses /u/<caller>/mcp and stashes the caller here;
# tools fall back to it when no explicit user_id argument is given. In stdio
# mode (the gateway) it stays unset and HIPPOCAMPAI_USER is the default.
import contextvars
_CALLER_USER: "contextvars.ContextVar[str]" = contextvars.ContextVar("memory_caller_user", default="")


def _current_user() -> str:
    return _CALLER_USER.get() or HIPPOCAMPAI_USER
RERANKER_URL = os.environ.get("RERANKER_URL", f"{PROXLAB_URL}/api/proxy/rerank/v2/rerank")
EMBED_URL = os.environ.get("EMBED_URL", f"{PROXLAB_URL}/api/proxy/embed/v1/embeddings")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "Qwen3-VL-Embedding-8B")
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "unified_memory")
EMBED_DIM = int(os.environ.get("EMBED_DIM", "4096"))
WAL_DIR = os.environ.get("WAL_DIR", "/tmp/unified-memory-wal")
SYNC_INTERVAL = int(os.environ.get("SYNC_INTERVAL", "60"))

# Vector DBs to write to (read from ProxLab config, or use defaults)
VECTOR_DBS = [
    {"name": "qdrant", "type": "qdrant", "host": "10.0.0.48", "port": 6333},
    {"name": "weaviate", "type": "weaviate", "host": "10.0.0.73", "port": 8080},
    {"name": "chromadb", "type": "chromadb", "host": "10.0.0.33", "port": 8000},
]

# ─── MCP Server ──────────────────────────────────────────────────────────────

mcp = FastMCP(
    "unified-memory",
    instructions=(
        "Unified RAG memory with multi-vector-DB consensus search. "
        "Writes are replicated across Qdrant, Milvus, Weaviate, ChromaDB, and HippocampAI. "
        "Recalls use consensus search with Reciprocal Rank Fusion and cross-encoder reranking. "
        "Use 'remember' to store facts and 'recall' to retrieve them."
    ),
)

_client: Optional[httpx.Client] = None


def get_client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=30.0)
    return _client


# ─── Write-Ahead Log ─────────────────────────────────────────────────────────

class WriteAheadLog:
    """Simple file-based WAL for tracking writes across vector DBs."""

    def __init__(self, wal_dir: str):
        self.wal_dir = Path(wal_dir)
        self.wal_dir.mkdir(parents=True, exist_ok=True)
        self.wal_file = self.wal_dir / "wal.jsonl"
        self.state_file = self.wal_dir / "db_state.json"

    def append(self, entry: dict) -> int:
        """Append a write entry and return the WAL ID."""
        wal_id = int(time.time() * 1000)
        entry["_wal_id"] = wal_id
        entry["_timestamp"] = time.time()
        with open(self.wal_file, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return wal_id

    def get_db_state(self) -> dict:
        """Get last applied WAL ID per DB."""
        try:
            if self.state_file.exists():
                return json.loads(self.state_file.read_text())
        except Exception:
            pass
        return {}

    def mark_applied(self, db_name: str, wal_id: int):
        """Mark a WAL entry as applied to a DB."""
        state = self.get_db_state()
        state[db_name] = max(state.get(db_name, 0), wal_id)
        self.state_file.write_text(json.dumps(state))

    def get_pending(self, db_name: str) -> list:
        """Get all WAL entries not yet applied to a DB."""
        state = self.get_db_state()
        last_applied = state.get(db_name, 0)
        pending = []
        try:
            if not self.wal_file.exists():
                return []
            with open(self.wal_file) as f:
                for line in f:
                    entry = json.loads(line.strip())
                    if entry.get("_wal_id", 0) > last_applied:
                        pending.append(entry)
        except Exception:
            pass
        return pending

    def compact(self, keep_last_n: int = 1000):
        """Remove old WAL entries, keeping last N."""
        try:
            if not self.wal_file.exists():
                return
            with open(self.wal_file) as f:
                lines = f.readlines()
            if len(lines) > keep_last_n:
                with open(self.wal_file, "w") as f:
                    f.writelines(lines[-keep_last_n:])
        except Exception:
            pass


wal = WriteAheadLog(WAL_DIR)


# ─── Embedding ───────────────────────────────────────────────────────────────

def vectorize(texts: list[str]) -> list[list[float]]:
    """Vectorize text using the ProxLab embed proxy."""
    client = get_client()
    try:
        resp = client.post(
            f"{EMBED_URL}",
            json={"model": EMBED_MODEL, "input": texts},
            timeout=60.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return [d["embedding"] for d in data.get("data", [])]
    except Exception as e:
        print(f"[unified-memory] Embedding failed: {e}")
        return []


# ─── Vector DB Writers ───────────────────────────────────────────────────────

def stable_point_id(memory_id: str) -> int:
    """Stable integer point id for a memory_id.

    MUST NOT use hash(): Python randomizes str hashing per process (no
    PYTHONHASHSEED here), so the same doc_id would land on a different point
    after each restart and a rewrite would append a duplicate instead of
    replacing. blake2b is stable across processes and versions.
    """
    return int.from_bytes(hashlib.blake2b(memory_id.encode("utf-8"), digest_size=8).digest(), "big") % (2**63)


def write_to_qdrant(client: httpx.Client, db: dict, memory_id: str, vector: list, payload: dict) -> bool:
    try:
        int_id = stable_point_id(memory_id)
        resp = client.put(
            f"http://{db['host']}:{db['port']}/collections/{COLLECTION_NAME}/points",
            json={"points": [{"id": int_id, "vector": vector, "payload": {**payload, "_memory_id": memory_id}}]},
            timeout=10.0,
        )
        return resp.status_code < 400
    except Exception as e:
        print(f"[unified-memory] Qdrant write failed: {e}")
        return False


def write_to_milvus(client: httpx.Client, db: dict, memory_id: str, vector: list, payload: dict) -> bool:
    try:
        resp = client.post(
            f"http://{db['host']}:{db['port']}/v2/vectordb/entities/insert",
            json={
                "collectionName": COLLECTION_NAME,
                "data": [{"vector": vector, "text": payload.get("text", ""), "_memory_id": memory_id}],
            },
            timeout=10.0,
        )
        return resp.status_code < 400
    except Exception as e:
        print(f"[unified-memory] Milvus write failed: {e}")
        return False


def _weaviate_object_uuid(weaviate_class: str, memory_id: str) -> str:
    """Deterministic object UUID for a (class, memory_id) pair.

    Weaviate has no upsert-by-arbitrary-key. Deriving the object UUID from the
    memory_id is what makes a repeat write REPLACE the object instead of adding
    a second copy of the same doc.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{weaviate_class}:{memory_id}"))


def write_to_weaviate(client: httpx.Client, db: dict, memory_id: str, vector: list, payload: dict) -> bool:
    try:
        weaviate_class = COLLECTION_NAME[0].upper() + COLLECTION_NAME[1:]
        obj_id = _weaviate_object_uuid(weaviate_class, memory_id)
        body = {
            "class": weaviate_class,
            "id": obj_id,
            "vector": vector,
            "properties": {"text": payload.get("text", ""), "metadata": json.dumps(payload), "memory_id": memory_id},
        }
        base = f"http://{db['host']}:{db['port']}/v1/objects"
        resp = client.post(base, json=body, timeout=10.0)
        # POST refuses an id that already exists (422/409) -> PUT replaces in place.
        if resp.status_code in (409, 422):
            resp = client.put(f"{base}/{weaviate_class}/{obj_id}", json=body, timeout=10.0)
        return resp.status_code < 400
    except Exception as e:
        print(f"[unified-memory] Weaviate write failed: {e}")
        return False


def write_to_chromadb(client: httpx.Client, db: dict, memory_id: str, vector: list, payload: dict) -> bool:
    try:
        # Get collection ID
        cols_resp = client.get(
            f"http://{db['host']}:{db['port']}/api/v2/tenants/default_tenant/databases/default_database/collections",
            timeout=5.0,
        )
        cols = cols_resp.json()
        col = next((c for c in cols if c["name"] == COLLECTION_NAME), None)
        if not col:
            return False
        resp = client.post(
            f"http://{db['host']}:{db['port']}/api/v2/tenants/default_tenant/databases/default_database/collections/{col['id']}/upsert",
            json={
                "ids": [memory_id],
                "embeddings": [vector],
                "metadatas": [payload],
                "documents": [payload.get("text", "")],
            },
            timeout=10.0,
        )
        return resp.status_code < 400
    except Exception as e:
        print(f"[unified-memory] ChromaDB write failed: {e}")
        return False


WRITERS = {
    "qdrant": write_to_qdrant,
    "milvus": write_to_milvus,
    "weaviate": write_to_weaviate,
    "chromadb": write_to_chromadb,
}


def write_to_all_dbs(memory_id: str, vector: list, payload: dict) -> dict:
    """Write a vector to all configured DBs. Returns per-DB status."""
    client = get_client()
    results = {}
    wal_id = wal.append({"op": "upsert", "memory_id": memory_id, "payload": payload})

    for db in VECTOR_DBS:
        writer = WRITERS.get(db["type"])
        if writer:
            ok = writer(client, db, memory_id, vector, payload)
            results[db["name"]] = ok
            if ok:
                wal.mark_applied(db["name"], wal_id)
        else:
            results[db["name"]] = False

    return results


# ─── HippocampAI Integration ────────────────────────────────────────────────

def write_to_hippocampai(text: str, mem_type: str, importance: float, tags: list, user_id: str) -> Optional[dict]:
    """Write to HippocampAI via its REST API."""
    client = get_client()
    try:
        payload = {
            "text": text,
            "user_id": user_id or _current_user(),
            "type": mem_type,
            "importance": importance,
        }
        if tags:
            payload["tags"] = tags
        resp = client.post(f"{HIPPOCAMPAI_URL}/v1/memories:remember", json=payload, timeout=30.0)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"[unified-memory] HippocampAI write failed: {e}")
        return None


def recall_from_hippocampai(query: str, k: int, user_id: str) -> list:
    """Recall from HippocampAI — returns pre-ranked results with BM25 + reranking."""
    client = get_client()
    try:
        resp = client.post(
            f"{HIPPOCAMPAI_URL}/v1/memories:recall",
            json={"query": query, "user_id": user_id or _current_user(), "k": k},
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data if isinstance(data, list) else data.get("results", [data])
        out = []
        for r in results:
            mem = r.get("memory", r) if isinstance(r, dict) else r
            if isinstance(mem, dict):
                out.append({
                    "text": mem.get("text", "")[:500],
                    "score": r.get("score", 0) if isinstance(r, dict) else 0,
                    "type": mem.get("type"),
                    "importance": mem.get("importance"),
                    "tags": mem.get("tags", []),
                    "id": mem.get("id"),
                    "source": "hippocampai",
                    "created_at": mem.get("created_at"),
                })
        return out
    except Exception as e:
        print(f"[unified-memory] HippocampAI recall failed: {e}")
        return []


# ─── Vector DB Search ────────────────────────────────────────────────────────

def search_qdrant(client: httpx.Client, db: dict, query_vector: list, k: int) -> list:
    try:
        resp = client.post(
            f"http://{db['host']}:{db['port']}/collections/{COLLECTION_NAME}/points/query",
            json={"query": query_vector, "limit": k, "with_payload": True},
            timeout=15.0,
        )
        data = resp.json()
        return [
            {"text": p.get("payload", {}).get("text", "")[:500], "score": p.get("score", 0),
             "id": p.get("payload", {}).get("_memory_id", str(p.get("id", ""))),
             "source": "qdrant", "rank": i + 1, "metadata": p.get("payload", {})}
            for i, p in enumerate(data.get("result", {}).get("points", []))
        ]
    except Exception as e:
        print(f"[unified-memory] Qdrant search failed: {e}")
        return []


def search_milvus(client: httpx.Client, db: dict, query_vector: list, k: int) -> list:
    try:
        resp = client.post(
            f"http://{db['host']}:{db['port']}/v2/vectordb/entities/search",
            json={"collectionName": COLLECTION_NAME, "data": [query_vector], "annsField": "vector",
                  "limit": k, "outputFields": ["text", "_memory_id", "user_id"]},
            timeout=15.0,
        )
        data = resp.json()
        return [
            {"text": p.get("text", "")[:500], "score": p.get("distance", 0),
             "id": p.get("_memory_id", str(p.get("id", ""))),
             "source": "milvus", "rank": i + 1, "metadata": {"user_id": p.get("user_id", "")}}
            for i, p in enumerate(data.get("data", []))
        ]
    except Exception as e:
        print(f"[unified-memory] Milvus search failed: {e}")
        return []


def search_weaviate(client: httpx.Client, db: dict, query_vector: list, k: int) -> list:
    try:
        weaviate_class = COLLECTION_NAME[0].upper() + COLLECTION_NAME[1:]
        resp = client.post(
            f"http://{db['host']}:{db['port']}/v1/graphql",
            json={"query": f'{{ Get {{ {weaviate_class}(nearVector: {{vector: {json.dumps(query_vector)}}}, limit: {k}) {{ text memory_id metadata _additional {{ id distance }} }} }} }}'},
            timeout=15.0,
        )
        data = resp.json()
        results = data.get("data", {}).get("Get", {}).get(weaviate_class, [])
        out = []
        for i, p in enumerate(results):
            # weaviate has no top-level user_id property; writes stash the full
            # payload (incl. user_id) as a JSON string in the metadata prop
            try:
                owner = json.loads(p.get("metadata") or "{}").get("user_id", "")
            except Exception:
                owner = ""
            out.append(
                {"text": p.get("text", "")[:500], "score": 1 - (p.get("_additional", {}).get("distance", 0)),
                 "id": p.get("memory_id", p.get("_additional", {}).get("id", "")),
                 "source": "weaviate", "rank": i + 1, "metadata": {"user_id": owner}})
        return out
    except Exception as e:
        print(f"[unified-memory] Weaviate search failed: {e}")
        return []


def search_chromadb(client: httpx.Client, db: dict, query_vector: list, k: int) -> list:
    try:
        cols_resp = client.get(
            f"http://{db['host']}:{db['port']}/api/v2/tenants/default_tenant/databases/default_database/collections",
            timeout=5.0,
        )
        cols = cols_resp.json()
        col = next((c for c in cols if c["name"] == COLLECTION_NAME), None)
        if not col:
            return []
        resp = client.post(
            f"http://{db['host']}:{db['port']}/api/v2/tenants/default_tenant/databases/default_database/collections/{col['id']}/query",
            json={"query_embeddings": [query_vector], "n_results": k, "include": ["documents", "metadatas", "distances"]},
            timeout=15.0,
        )
        data = resp.json()
        ids = data.get("ids", [[]])[0]
        docs = data.get("documents", [[]])[0]
        dists = data.get("distances", [[]])[0]
        metas = data.get("metadatas", [[]])[0]
        return [
            {"text": docs[i][:500] if i < len(docs) else "", "score": 1 - (dists[i] if i < len(dists) else 0),
             "id": ids[i] if i < len(ids) else "", "source": "chromadb", "rank": i + 1,
             "metadata": {"user_id": (metas[i] or {}).get("user_id", "") if i < len(metas) else ""}}
            for i in range(len(ids))
        ]
    except Exception as e:
        print(f"[unified-memory] ChromaDB search failed: {e}")
        return []


SEARCHERS = {
    "qdrant": search_qdrant,
    "milvus": search_milvus,
    "weaviate": search_weaviate,
    "chromadb": search_chromadb,
}


# ─── Consensus Search + Reranking ────────────────────────────────────────────

def reciprocal_rank_fusion(results_by_source: dict, k: int = 60) -> list:
    """Merge ranked results from multiple sources using RRF."""
    scores = {}
    for source, results in results_by_source.items():
        for r in results:
            key = r.get("text", r.get("id", ""))[:200]  # Dedup by text prefix
            if key not in scores:
                scores[key] = {**r, "rrf_score": 0, "sources": [], "native_scores": {}}
            scores[key]["rrf_score"] += 1 / (k + r.get("rank", len(results)))
            scores[key]["sources"].append(source)
            scores[key]["native_scores"][source] = r.get("score", 0)

    return sorted(scores.values(), key=lambda x: x["rrf_score"], reverse=True)


def rerank(query: str, results: list) -> list:
    """Rerank results using the Nemotron cross-encoder. Falls back to RRF order."""
    if len(results) <= 1:
        return results

    documents = [r.get("text", "") for r in results if r.get("text")]
    if not documents:
        return results

    client = get_client()
    try:
        resp = client.post(
            RERANKER_URL,
            json={"query": query, "documents": documents},
            timeout=15.0,
        )
        if resp.status_code != 200:
            return results

        reranked = resp.json().get("results", [])
        score_map = {r["index"]: r["relevance_score"] for r in reranked}

        # Map scores back to results
        text_results = [r for r in results if r.get("text")]
        for i, r in enumerate(text_results):
            r["reranker_score"] = score_map.get(i, 0)

        return sorted(text_results, key=lambda x: x.get("reranker_score", 0), reverse=True)
    except Exception as e:
        print(f"[unified-memory] Reranking failed: {e}")
        return results


def consensus_recall(query: str, k: int, user_id: str) -> list:
    """Full consensus recall: search all sources, merge with RRF, rerank."""
    # 1. Vectorize the query
    vecs = vectorize([query])
    query_vector = vecs[0] if vecs else None

    results_by_source = {}

    # 2. Search HippocampAI (smart source — has its own BM25 + reranking)
    hippo_results = recall_from_hippocampai(query, k, user_id)
    if hippo_results:
        # Assign ranks to HippocampAI results
        for i, r in enumerate(hippo_results):
            r["rank"] = i + 1
        results_by_source["hippocampai"] = hippo_results

    # 3. Search all vector DBs in parallel (if we have a query vector).
    # NAMESPACE FILTER (consolidation 2026-07-07): the vector DBs share one
    # collection across callers; every write stamps user_id in the payload,
    # so drop hits owned by OTHER namespaces here. Legacy entries without a
    # user_id belong to the historical shared default ("claude").
    resolved_user = user_id or _current_user()
    if query_vector:
        client = get_client()
        for db in VECTOR_DBS:
            searcher = SEARCHERS.get(db["type"])
            if searcher:
                db_results = searcher(client, db, query_vector, k)
                kept = []
                for r in db_results or []:
                    owner = (r.get("metadata") or {}).get("user_id", "") or HIPPOCAMPAI_USER
                    if owner == resolved_user:
                        kept.append(r)
                for i, r in enumerate(kept):
                    r["rank"] = i + 1
                if kept:
                    results_by_source[db["name"]] = kept

    if not results_by_source:
        return []

    # 4. Merge with Reciprocal Rank Fusion
    fused = reciprocal_rank_fusion(results_by_source)

    # 5. Rerank with Nemotron
    reranked = rerank(query, fused[:k * 2])  # Rerank top 2x candidates

    return reranked[:k]


# ─── WAL Sync ────────────────────────────────────────────────────────────────

def sync_pending():
    """Replay pending WAL entries to any DB that missed writes."""
    client = get_client()
    synced = 0
    for db in VECTOR_DBS:
        pending = wal.get_pending(db["name"])
        if not pending:
            continue
        writer = WRITERS.get(db["type"])
        if not writer:
            continue
        for entry in pending:
            if entry.get("op") != "upsert":
                continue
            # Re-vectorize the text (we don't store vectors in the WAL)
            text = entry.get("payload", {}).get("text", "")
            if not text:
                continue
            vecs = vectorize([text])
            if not vecs:
                continue
            ok = writer(client, db, entry["memory_id"], vecs[0], entry["payload"])
            if ok:
                wal.mark_applied(db["name"], entry["_wal_id"])
                synced += 1
    if synced:
        print(f"[unified-memory] Synced {synced} pending writes")
    wal.compact()
    return synced


# ─── MCP Tools ───────────────────────────────────────────────────────────────

@mcp.tool()
def remember(
    text: str,
    type: str = "fact",
    importance: float = 7.0,
    tags: str = "",
    user_id: str = "",
) -> str:
    """Store a memory across all vector databases and HippocampAI.

    Memories are replicated for redundancy and consensus search.

    Args:
        text: The memory content to store.
        type: Memory type — fact, preference, goal, habit, event, context
        importance: Importance score 1-10 (higher = more resistant to decay)
        tags: Comma-separated tags for filtering
        user_id: User namespace (default: "claude")
    """
    memory_id = str(uuid.uuid4())
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []

    # 1. Vectorize
    vecs = vectorize([text])
    if not vecs:
        return json.dumps({"error": "Failed to vectorize text"})

    payload = {
        "text": text,
        "type": type,
        "importance": importance,
        "tags": tag_list,
        "user_id": user_id or _current_user(),
        "memory_id": memory_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # 2. Write to all vector DBs
    db_results = write_to_all_dbs(memory_id, vecs[0], payload)

    # 3. Write to HippocampAI
    hippo_result = write_to_hippocampai(text, type, importance, tag_list, user_id)

    # 4. Sync any pending writes from previous failures
    sync_pending()

    successful = sum(1 for v in db_results.values() if v) + (1 if hippo_result else 0)
    total = len(db_results) + 1

    return json.dumps({
        "id": memory_id,
        "text": text[:200],
        "type": type,
        "importance": importance,
        "replicated_to": f"{successful}/{total} backends",
        "backends": {**db_results, "hippocampai": bool(hippo_result)},
    }, indent=2)


@mcp.tool()
def recall(
    query: str,
    k: int = 10,
    user_id: str = "",
) -> str:
    """Recall memories using consensus search across all vector databases.

    Searches HippocampAI (with BM25 + its own reranking) and all vector DBs,
    merges results with Reciprocal Rank Fusion, then reranks with Nemotron.

    Args:
        query: Natural language query.
        k: Number of results (default 10, max 50).
        user_id: User namespace (default: "claude").
    """
    results = consensus_recall(query, min(k, 50), user_id or _current_user())

    output = []
    for i, r in enumerate(results):
        output.append({
            "rank": i + 1,
            "text": r.get("text", "")[:500],
            "score": round(r.get("reranker_score", r.get("rrf_score", 0)), 4),
            "sources": r.get("sources", []),
            "consensus": len(r.get("sources", [])),
            "type": r.get("type"),
            "importance": r.get("importance"),
            "tags": r.get("tags", []),
            "id": r.get("id"),
        })

    return json.dumps(output, indent=2)


@mcp.tool()
def search_memories(
    user_id: str = "",
    type_filter: str = "",
    limit: int = 20,
) -> str:
    """List stored memories via HippocampAI with optional filtering.

    Args:
        user_id: User namespace (default: "claude").
        type_filter: Filter by type (fact, preference, etc). Empty = all.
        limit: Max results (default 20, max 100).
    """
    client = get_client()
    payload = {"user_id": user_id or _current_user(), "limit": min(limit, 100)}
    if type_filter:
        payload["filters"] = {"type": type_filter}
    try:
        resp = client.post(f"{HIPPOCAMPAI_URL}/v1/memories:get", json=payload, timeout=30.0)
        resp.raise_for_status()
        data = resp.json()
        memories = data if isinstance(data, list) else data.get("memories", [])
        return json.dumps([
            {"id": m.get("id"), "text": m.get("text", "")[:200], "type": m.get("type"),
             "importance": m.get("importance"), "tags": m.get("tags", []), "created_at": m.get("created_at")}
            for m in memories
        ], indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def delete_memory(memory_id: str, user_id: str = "") -> str:
    """Delete a memory from HippocampAI by ID.

    Note: This only deletes from HippocampAI. Vector DB copies remain
    but will be naturally excluded from future results as they age out.

    Args:
        memory_id: The UUID of the memory to delete.
        user_id: User namespace (default: "claude").
    """
    client = get_client()
    try:
        resp = client.request(
            "DELETE", f"{HIPPOCAMPAI_URL}/v1/memories:delete",
            json={"memory_id": memory_id, "user_id": user_id or _current_user()},
            timeout=10.0,
        )
        resp.raise_for_status()
        return json.dumps({"deleted": True, "memory_id": memory_id})
    except Exception as e:
        return json.dumps({"error": str(e)})


@mcp.tool()
def memory_health() -> str:
    """Check health of all memory backends."""
    client = get_client()
    health = {}

    # HippocampAI
    try:
        resp = client.get(f"{HIPPOCAMPAI_URL}/v1/intelligence/health", timeout=5.0)
        health["hippocampai"] = {"healthy": resp.status_code == 200, "data": resp.json()}
    except Exception as e:
        health["hippocampai"] = {"healthy": False, "error": str(e)}

    # Vector DBs
    for db in VECTOR_DBS:
        try:
            health_paths = {"qdrant": "/collections", "milvus": "/v2/vectordb/collections/list",
                           "weaviate": "/v1/meta", "chromadb": "/api/v2/heartbeat"}
            path = health_paths.get(db["type"], "/health")
            method = "POST" if db["type"] == "milvus" else "GET"
            kwargs = {"json": {}} if method == "POST" else {}
            resp = client.request(method, f"http://{db['host']}:{db['port']}{path}", timeout=5.0, **kwargs)
            health[db["name"]] = {"healthy": resp.status_code < 400}
        except Exception as e:
            health[db["name"]] = {"healthy": False, "error": str(e)}

    # Reranker
    try:
        resp = client.post(RERANKER_URL, json={"query": "test", "documents": ["test"]}, timeout=5.0)
        health["reranker"] = {"healthy": resp.status_code == 200}
    except Exception as e:
        health["reranker"] = {"healthy": False, "error": str(e)}

    # WAL status
    state = wal.get_db_state()
    pending_counts = {db["name"]: len(wal.get_pending(db["name"])) for db in VECTOR_DBS}
    health["wal"] = {"pending_syncs": pending_counts, "db_state": state}

    healthy_count = sum(1 for v in health.values() if isinstance(v, dict) and v.get("healthy"))
    total = len([v for v in health.values() if isinstance(v, dict) and "healthy" in v])

    return json.dumps({
        "status": "healthy" if healthy_count == total else "degraded" if healthy_count > 0 else "unhealthy",
        "backends": f"{healthy_count}/{total} online",
        "details": health,
    }, indent=2)


@mcp.tool()
def extract_facts(conversation: str, user_id: str = "") -> str:
    """Extract and store memories from a conversation via HippocampAI.

    Args:
        conversation: The conversation text to extract memories from.
        user_id: User namespace (default: "claude").
    """
    client = get_client()
    try:
        resp = client.post(
            f"{HIPPOCAMPAI_URL}/v1/memories:extract",
            json={"conversation": conversation, "user_id": user_id or _current_user()},
            timeout=60.0,
        )
        resp.raise_for_status()
        data = resp.json()

        # Also replicate extracted facts to all vector DBs
        if isinstance(data, list):
            for m in data:
                text = m.get("text", "")
                if text:
                    vecs = vectorize([text])
                    if vecs:
                        payload = {"text": text, "type": m.get("type", "fact"),
                                   "importance": m.get("importance", 5), "user_id": user_id or _current_user()}
                        write_to_all_dbs(m.get("id", str(uuid.uuid4())), vecs[0], payload)

            return json.dumps([
                {"id": m.get("id"), "text": m.get("text", "")[:200], "type": m.get("type"),
                 "importance": m.get("importance")}
                for m in data
            ], indent=2)
        return json.dumps(data, indent=2)
    except Exception as e:
        return json.dumps({"error": str(e)})


# ─── Custom Collections (no HippocampAI) ────────────────────────────────────
# For indexing repos, documents, or any data that needs its own collection
# without being mixed into the main memory pool.

def _create_collection_if_needed(collection: str):
    """Create a collection across all standard vector DBs if it doesn't exist."""
    client = get_client()
    for db in VECTOR_DBS:
        try:
            url = f"http://{db['host']}:{db['port']}"
            if db["type"] == "qdrant":
                # Check if exists
                r = client.get(f"{url}/collections/{collection}", timeout=5.0)
                if r.status_code == 404:
                    client.put(f"{url}/collections/{collection}",
                               json={"vectors": {"size": EMBED_DIM, "distance": "Cosine"}}, timeout=10.0)
            elif db["type"] == "milvus":
                client.post(f"{url}/v2/vectordb/collections/create",
                            json={"collectionName": collection, "schema": {
                                "autoId": True, "enableDynamicField": True,
                                "fields": [
                                    {"fieldName": "id", "dataType": "Int64", "isPrimary": True},
                                    {"fieldName": "vector", "dataType": "FloatVector", "elementTypeParams": {"dim": str(EMBED_DIM)}},
                                    {"fieldName": "text", "dataType": "VarChar", "elementTypeParams": {"max_length": "65535"}},
                                ]}}, timeout=10.0)
                client.post(f"{url}/v2/vectordb/indexes/create",
                            json={"collectionName": collection, "indexParams": [{"fieldName": "vector", "metricType": "COSINE", "indexType": "AUTOINDEX"}]}, timeout=10.0)
                client.post(f"{url}/v2/vectordb/collections/load", json={"collectionName": collection}, timeout=10.0)
            elif db["type"] == "weaviate":
                wc = collection[0].upper() + collection[1:]
                r = client.get(f"{url}/v1/schema/{wc}", timeout=5.0)
                if r.status_code == 404:
                    client.post(f"{url}/v1/schema", json={"class": wc, "vectorizer": "none",
                        "properties": [{"name": "text", "dataType": ["text"]}, {"name": "metadata", "dataType": ["text"]}, {"name": "doc_id", "dataType": ["text"]}]}, timeout=10.0)
            elif db["type"] == "chromadb":
                client.post(f"{url}/api/v2/tenants/default_tenant/databases/default_database/collections",
                            json={"name": collection, "metadata": {"dimension": EMBED_DIM}}, timeout=10.0)
        except Exception:
            pass


@mcp.tool()
def collection_store(
    collection: str,
    text: str,
    doc_id: str = "",
    metadata: str = "",
) -> str:
    """Store a document in a custom named collection across all vector DBs (not HippocampAI).

    Use this for indexing repos, documents, knowledge bases, or any data
    that should be in its own searchable collection separate from main memory.

    Args:
        collection: Collection name (e.g., 'repo_proxlab', 'docs_kubernetes')
        text: The text content to store and vectorize.
        doc_id: Optional document ID for deduplication.
        metadata: Optional JSON metadata string.
    """
    _create_collection_if_needed(collection)

    doc_id = doc_id or str(uuid.uuid4())
    vecs = vectorize([text])
    if not vecs:
        return json.dumps({"error": "Failed to vectorize text"})

    meta = {}
    if metadata:
        try:
            meta = json.loads(metadata)
        except Exception:
            meta = {"raw": metadata}

    payload = {"text": text, "doc_id": doc_id, **meta}

    # Write to all vector DBs (not HippocampAI)
    client = get_client()
    results = {}
    for db in VECTOR_DBS:
        writer = WRITERS.get(db["type"])
        if writer:
            # Temporarily swap COLLECTION_NAME
            saved = globals().get("COLLECTION_NAME")
            globals()["COLLECTION_NAME"] = collection
            ok = writer(client, db, doc_id, vecs[0], payload)
            globals()["COLLECTION_NAME"] = saved
            results[db["name"]] = ok

    successful = sum(1 for v in results.values() if v)
    return json.dumps({
        "collection": collection,
        "doc_id": doc_id,
        "text": text[:100],
        "replicated_to": f"{successful}/{len(results)}",
        "backends": results,
    }, indent=2)


@mcp.tool()
def collection_search(
    collection: str,
    query: str,
    k: int = 10,
) -> str:
    """Search a custom named collection with consensus search + reranking.

    Searches all vector DBs (not HippocampAI), merges with RRF, reranks.

    Args:
        collection: Collection name to search.
        query: Search query text.
        k: Number of results (default 10).
    """
    vecs = vectorize([query])
    if not vecs:
        return json.dumps({"error": "Failed to vectorize query"})

    query_vector = vecs[0]
    client = get_client()
    results_by_source = {}

    for db in VECTOR_DBS:
        searcher = SEARCHERS.get(db["type"])
        if searcher:
            # Temporarily swap collection name
            saved = globals().get("COLLECTION_NAME")
            globals()["COLLECTION_NAME"] = collection
            db_results = searcher(client, db, query_vector, k)
            globals()["COLLECTION_NAME"] = saved
            if db_results:
                results_by_source[db["name"]] = db_results

    if not results_by_source:
        return json.dumps({"collection": collection, "results": [], "message": "No results found"})

    fused = reciprocal_rank_fusion(results_by_source)
    reranked = rerank(query, fused[:k * 2])

    output = [{
        "rank": i + 1,
        "text": r.get("text", "")[:500],
        "score": round(r.get("reranker_score", r.get("rrf_score", 0)), 4),
        "sources": r.get("sources", []),
        "consensus": len(r.get("sources", [])),
        "doc_id": r.get("id"),
    } for i, r in enumerate(reranked[:k])]

    return json.dumps({"collection": collection, "query": query, "results": output}, indent=2)


@mcp.tool()
def collection_list() -> str:
    """List all custom collections across vector DBs."""
    client = get_client()
    all_collections = set()
    per_db = {}

    for db in VECTOR_DBS:
        try:
            url = f"http://{db['host']}:{db['port']}"
            cols = []
            if db["type"] == "qdrant":
                r = client.get(f"{url}/collections", timeout=5.0)
                cols = [c["name"] for c in r.json().get("result", {}).get("collections", [])]
            elif db["type"] == "milvus":
                r = client.post(f"{url}/v2/vectordb/collections/list", json={}, timeout=5.0)
                cols = r.json().get("data", [])
            elif db["type"] == "weaviate":
                r = client.get(f"{url}/v1/schema", timeout=5.0)
                cols = [c["class"] for c in r.json().get("classes", [])]
            elif db["type"] == "chromadb":
                r = client.get(f"{url}/api/v2/tenants/default_tenant/databases/default_database/collections", timeout=5.0)
                cols = [c["name"] for c in r.json()]
            per_db[db["name"]] = cols
            all_collections.update(cols)
        except Exception:
            per_db[db["name"]] = []

    return json.dumps({
        "collections": sorted(all_collections),
        "per_db": per_db,
    }, indent=2)


def run():
    """Run the MCP server (stdio — the gateway's transport)."""
    mcp.run()


def run_http(port: int) -> None:
    """Streamable-HTTP mode with BEHIND-THE-SCENES per-caller namespacing.

    One process serves every caller: connect to /u/<name>/mcp and every
    remember/recall/etc. in that request is routed to user namespace <name>
    without any per-call ceremony. Bare /mcp = the shared default namespace
    (HIPPOCAMPAI_USER). Stateless HTTP so each request carries its identity.
    """
    import re

    import uvicorn

    mcp.settings.stateless_http = True
    # LAN service: accept Host headers for this box's addresses (the default
    # DNS-rebinding guard only allows localhost, which 421s the mcpjungle
    # gateway and any /u/<name>/mcp caller using the LAN IP).
    from mcp.server.transport_security import TransportSecuritySettings
    allowed = ["127.0.0.1:*", "localhost:*"]
    for h in (os.environ.get("MEMORY_MCP_ALLOWED_HOSTS") or "10.0.0.219").split(","):
        h = h.strip()
        if h:
            allowed.append(f"{h}:*")
    mcp.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True, allowed_hosts=allowed)
    app = mcp.streamable_http_app()
    path_re = re.compile(r"^/u/([A-Za-z0-9_.:-]+)(/.*)$")

    async def routed(scope, receive, send):
        if scope["type"] == "http":
            m = path_re.match(scope.get("path", ""))
            if m:
                _CALLER_USER.set(m.group(1))
                scope = dict(scope)
                scope["path"] = m.group(2)
                scope["raw_path"] = m.group(2).encode()
            else:
                _CALLER_USER.set("")
        await app(scope, receive, send)

    uvicorn.run(routed, host="0.0.0.0", port=port, lifespan="on", log_level="warning")
