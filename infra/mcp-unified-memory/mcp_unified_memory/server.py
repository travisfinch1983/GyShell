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
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP

# ─── Configuration ───────────────────────────────────────────────────────────

# Env var name kept — the systemd unit and README both set PROXLAB_URL, and
# lines below build RERANKER_URL/EMBED_URL from it. Only the fallback moved
# off the decommissioned host.
PROXLAB_URL = os.environ.get("PROXLAB_URL", "http://10.0.0.219:17890")
HIPPOCAMPAI_URL = os.environ.get("HIPPOCAMPAI_URL", "http://10.0.0.26:8000")
HIPPOCAMPAI_USER = os.environ.get("HIPPOCAMPAI_USER", "claude")

# Per-caller namespace routing (memory consolidation, 2026-07-07): in HTTP
# mode the ASGI middleware parses /u/<caller>/mcp and stashes the caller here;
# tools fall back to it when no explicit user_id argument is given. In stdio
# mode (the gateway) it stays unset and HIPPOCAMPAI_USER is the default.
import contextvars


# ── degradation emitter ─────────────────────────────────────────────────────────
# 🛑 Every silent-degradation path in this file has the same anatomy: the feature
# keeps answering (un-reranked order, base-collection recall, hippo-only results),
# so nothing looks broken while the answer quality quietly changes. print() goes
# to journald, which is where the reranker at 10.0.0.140 died unnoticed once
# already. These transitions must reach the notifications panel.
#
# Latched per subject: fires on the transition into failure (threshold crossed),
# once, and re-arms only after a success. Never raises — a degradation report
# must not be able to degrade anything itself.
_AILAB_API = os.environ.get("AILAB_API_URL", "http://127.0.0.1:17890").rstrip("/")
_EMIT_THRESHOLD = 3
_emit_streaks: dict = {}
_emit_lock = threading.Lock()


def _emit(severity: str, message: str, detail: str = "") -> None:
    try:
        import urllib.request
        body = json.dumps({"severity": severity, "source": "unified-memory",
                           "message": message, "detail": detail}).encode()
        req = urllib.request.Request(_AILAB_API + "/api/notifications/emit", body,
                                     {"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=3).read()
    except Exception as e:
        print(f"[unified-memory] NOTIFY LOST ({e}): {severity}: {message}")


def _degraded(subject: str, ok: bool, message: str = "", detail: str = "") -> None:
    """Record one outcome for `subject`; emit on the latched transitions only."""
    with _emit_lock:
        streak = _emit_streaks.get(subject, 0)
        if ok:
            if streak >= _EMIT_THRESHOLD:
                _emit("info", f"unified-memory: {subject} recovered",
                      f"Working again after {streak} consecutive failures.")
            _emit_streaks[subject] = 0
            return
        streak += 1
        _emit_streaks[subject] = streak
        fire = streak == _EMIT_THRESHOLD
    if fire:
        _emit("warning", message or f"unified-memory: {subject} degraded", detail)

_CALLER_USER: "contextvars.ContextVar[str]" = contextvars.ContextVar("memory_caller_user", default="")


def _current_user() -> str:
    return _CALLER_USER.get() or HIPPOCAMPAI_USER
RERANKER_URL = os.environ.get("RERANKER_URL", f"{PROXLAB_URL}/api/proxy/rerank/v2/rerank")
EMBED_URL = os.environ.get("EMBED_URL", f"{PROXLAB_URL}/api/proxy/embed/v1/embeddings")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "Qwen3-VL-Embedding-8B")
RERANKER_MODEL = os.environ.get("RERANKER_MODEL", "nvidia/llama-nemotron-rerank-vl-1b-v2")

# The embed/rerank MODEL is chosen in the AI-Lab Support Models tab, which persists
# to rag-models.json. Hardcoding it here is what let this service keep embedding
# through the retired V100 model after the UI was repointed at the FP8 pool -- corpus
# and queries then get encoded by DIFFERENT models, which silently degrades recall.
# Same live-read + 15s cache contract as the backend's vector-proxy.js: file wins,
# env/default is only the fallback.
RAG_MODELS_FILE = os.environ.get(
    "RAG_MODELS_FILE",
    os.path.join(os.environ.get("AILAB_PROXY_DATA_DIR", "/opt/ai-lab/.gybackend-data"), "rag-models.json"),
)
_RAG_CFG_TTL = 15.0
_rag_cfg_cache = {"cfg": None, "ts": 0.0}


def _embed_endpoint(base: str) -> str:
    """rag-models.json stores the pool base (.../embed/v1); we POST to /embeddings."""
    b = (base or "").rstrip("/")
    return b if b.endswith("/embeddings") else b + "/embeddings"


def _rerank_endpoint(base: str) -> str:
    b = (base or "").rstrip("/")
    return b if b.endswith("/rerank") else b + "/rerank"


def rag_model_cfg() -> dict:
    """Live-read the Support Models selection. Never raises: falls back to env/defaults."""
    now = time.monotonic()
    if _rag_cfg_cache["cfg"] is not None and now - _rag_cfg_cache["ts"] < _RAG_CFG_TTL:
        return _rag_cfg_cache["cfg"]
    raw = {}
    try:
        with open(RAG_MODELS_FILE, "r", encoding="utf-8") as fh:
            raw = json.load(fh) or {}
    except Exception:
        raw = {}
    cfg = {
        "embed_model": raw.get("embedModel") or EMBED_MODEL,
        "embed_url": _embed_endpoint(raw["embedUrl"]) if raw.get("embedUrl") else EMBED_URL,
        "rerank_model": raw.get("rerankModel") or RERANKER_MODEL,
        "rerank_url": _rerank_endpoint(raw["rerankUrl"]) if raw.get("rerankUrl") else RERANKER_URL,
    }
    _rag_cfg_cache["cfg"] = cfg
    _rag_cfg_cache["ts"] = now
    return cfg
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "unified_memory")
SEARCH_TEXT_LIMIT = 8000  # per-DB searcher result-text cap. recall/search_memories re-truncate at their own output layer; collection_search surfaces this directly so agents get full RAG chunks (benchmark tables etc.), not a 500-char preview.
EMBED_DIM = int(os.environ.get("EMBED_DIM", "4096"))
WAL_DIR = os.environ.get("WAL_DIR", "/tmp/unified-memory-wal")
SYNC_INTERVAL = int(os.environ.get("SYNC_INTERVAL", "60"))
# Max WAL entries replayed per backend per sync_pending call — bounds how long a
# backlog drain can take so it never makes a store slow.
SYNC_BATCH = int(os.environ.get("SYNC_BATCH", "25"))
WAL_BACKLOG_THRESHOLD = int(os.environ.get("WAL_BACKLOG_THRESHOLD", "200"))

# Vector DBs to write to (read from ProxLab config, or use defaults)
VECTOR_DBS = [
    # Dockerised into CT152 alongside AI-Lab 2026-07-27 (was the standalone CT166
    # at 10.0.0.48). Env-overridable so the next move does not need a code edit.
    {"name": "qdrant", "type": "qdrant",
     "host": os.environ.get("QDRANT_HOST", "127.0.0.1"),
     "port": int(os.environ.get("QDRANT_PORT", "6333"))},
    # Dockerised into CT152 2026-07-27 (was CT187 @10.0.0.73). Host port 8087 because
    # 8080 on CT152 is the AI-Lab MCP gateway.
    {"name": "weaviate", "type": "weaviate",
     "host": os.environ.get("WEAVIATE_HOST", "127.0.0.1"),
     "port": int(os.environ.get("WEAVIATE_PORT", "8087"))},
    # Dockerised into CT152 2026-07-27 (was CT164 @10.0.0.33).
    {"name": "chromadb", "type": "chromadb",
     "host": os.environ.get("CHROMA_HOST", "127.0.0.1"),
     "port": int(os.environ.get("CHROMA_PORT", "8000"))},
]

# ─── HippocampAI async-write tuning ──────────────────────────────────────────
# HippocampAI is a direct-write (non-WAL) backend that fails ~1-in-4. We never
# block the store on it: remember() records the write intent in the WAL, a
# background thread attempts it with retries, and sync_pending() replays any
# entry still unapplied after HIPPO_GRACE_SEC (covers writes lost to a restart).
HIPPO_RETRIES = int(os.environ.get("HIPPO_RETRIES", "3"))
HIPPO_GRACE_SEC = int(os.environ.get("HIPPO_GRACE_SEC", "120"))
# Hippo recall is a best-effort lane; cap it so a slow/loaded hippo can't hang consensus recall.
HIPPO_RECALL_TIMEOUT = float(os.environ.get("HIPPO_RECALL_TIMEOUT", "6.0"))

# ─── OpenViking recall lane ──────────────────────────────────────────────────
# OpenViking (a content/search engine, not a plain vector store) is a READ lane
# in the unified RRF consensus. It is WRITTEN by the Hermes auto-extraction path
# via its native content API — NOT by deliberate remember() calls (atomic facts
# would be noise to it). Disabled unless an API key is configured AND it health-
# checks, so an unreachable/unconfigured OpenViking is a safe no-op for recall.
OPENVIKING_URL = os.environ.get("OPENVIKING_URL", "http://127.0.0.1:1933")
OPENVIKING_API_KEY = os.environ.get("OPENVIKING_API_KEY", "")
OPENVIKING_ACCOUNT = os.environ.get("OPENVIKING_ACCOUNT", "")

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
        except Exception as e:
            # {} is the safe fallback (compact keeps everything, writes are
            # idempotent upserts so re-applying is harmless) — but it resets
            # every replay cursor, so say it happened.
            print(f"[unified-memory] WAL state file unreadable — treating all entries as unapplied: {e}")
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
                    try:
                        entry = json.loads(line.strip())
                    except Exception:
                        # One corrupt LINE used to abort the whole read via the
                        # outer except — pending silently read as empty and the
                        # backlog never drained. Skip the line, keep the rest.
                        print(f"[unified-memory] WAL: skipping unparseable line for {db_name}")
                        continue
                    if entry.get("_wal_id", 0) > last_applied:
                        pending.append(entry)
        except Exception as e:
            print(f"[unified-memory] WAL read failed for {db_name} — reporting no pending (backlog may exist): {e}")
        return pending

    def min_applied_wal_id(self) -> int:
        """The oldest applied position across ALL backends — entries at or
        below it are safe to drop; anything above is someone's backlog."""
        state = self.get_db_state()
        if not state:
            return 0
        return min(int(v) for v in state.values())

    def compact(self, keep_last_n: int = 1000):
        """Remove old WAL entries — but NEVER unapplied ones.

        🛑 The old compact kept the last N lines regardless of whether they
        had been replayed: a backend down for more than ~N writes had its
        backlog silently truncated — permanent loss, invisible, while
        memory_health computed the exact number nobody was watching. Now the
        floor is the slowest backend's applied position: the file may grow
        while a backend is down (that is the honest cost of not losing its
        writes), and the backlog emitter below is what keeps that growth
        from being silent."""
        try:
            if not self.wal_file.exists():
                return
            floor = self.min_applied_wal_id()
            with open(self.wal_file) as f:
                lines = f.readlines()
            if len(lines) <= keep_last_n:
                return
            keep = []
            for i, line in enumerate(lines):
                if i >= len(lines) - keep_last_n:
                    keep.append(line)
                    continue
                try:
                    if json.loads(line.strip()).get("_wal_id", 0) > floor:
                        keep.append(line)   # unapplied somewhere — NOT droppable
                except Exception:
                    keep.append(line)       # unparseable — keep; deciding it is junk is not compact's call
            if len(keep) < len(lines):
                with open(self.wal_file, "w") as f:
                    f.writelines(keep)
        except Exception as e:
            print(f"[unified-memory] WAL compact failed (kept everything): {e}")


wal = WriteAheadLog(WAL_DIR)


# ─── Embedding-model fingerprint → collection routing ────────────────────────
# The SAME served model name can cover multiple quantisations (Qwen3-VL-Embedding-8B
# is both the 4-bit and the FP8 build), and vectors from different builds are only
# ~0.96 apart — close enough to look plausible while silently degrading ranking.
# So we fingerprint on model_id + the weights `root` path the endpoint reports,
# and route to the collections produced by THAT encoder.
#
# Resolution happens at CALL TIME from the endpoint actually in use, NOT from the
# Support Models default — a tool pointed at a different embedder reaches its own
# collections. Callers pass base_url/model_id; omitting them uses the default.
#
# ONLY QDRANT is suffixed. weaviate/chroma were never re-embedded, so they still
# hold the original encoder's vectors natively and must be queried unsuffixed.
FINGERPRINT_FILE = os.environ.get(
    "FINGERPRINT_FILE",
    os.path.join(os.environ.get("AILAB_PROXY_DATA_DIR", "/opt/ai-lab/.gybackend-data"),
                 "collection-fingerprints.json"))
_FP_TTL = 60.0
_fp_cache: dict = {}
_manifest_cache: tuple = (0.0, {})


def fingerprint_manifest() -> dict:
    """Live-read the fingerprint manifest. Never raises."""
    global _manifest_cache
    ts, data = _manifest_cache
    now = time.time()
    if now - ts < _FP_TTL and data:
        return data
    try:
        with open(FINGERPRINT_FILE) as fh:
            data = json.load(fh)
    except Exception:
        data = {}
    _manifest_cache = (now, data)
    return data


def embed_fingerprint(base_url: str = "", model_id: str = "") -> str:
    """sha1(model_id|root)[:12] for the embedder actually serving base_url.

    The `root` (weights path) is what distinguishes quantisations of the same
    served name. Returns "" if the endpoint cannot be interrogated — callers
    then fall back to the default suffix rather than guessing wrong.
    """
    cfg = rag_model_cfg()
    base = (base_url or cfg["embed_url"]).rstrip("/")
    if base.endswith("/embeddings"):
        base = base[: -len("/embeddings")]
    mid = model_id or cfg["embed_model"]
    key = f"{base}|{mid}"
    now = time.time()
    hit = _fp_cache.get(key)
    if hit and hit[1] > now:
        return hit[0]
    fp = ""
    try:
        resp = get_client().get(f"{base}/models", timeout=8.0)
        entry = next((m for m in (resp.json().get("data") or []) if m.get("id") == mid), None)
        if entry is not None:
            fp = hashlib.sha1(f"{mid}|{entry.get('root','')}".encode()).hexdigest()[:12]
    except Exception as e:
        print(f"[unified-memory] fingerprint probe failed for {base}: {e}")
        _degraded("embed-fingerprint", False,
                  "Embed fingerprint probe failing — recall may be querying the WRONG collections",
                  f"{e}. With no fingerprint, collection routing falls through to the base names, "
                  "which the manifest's 'unresolved' block says do not match the active query "
                  "encoder. Recall answers normally but from vectors of a different embedding model.")
    if fp:
        _degraded("embed-fingerprint", True)
    _fp_cache[key] = (fp, now + _FP_TTL)
    return fp


def collection_suffix(backend: str = "qdrant", base_url: str = "", model_id: str = "") -> str:
    """Collection suffix for the embedder in use, FOR A GIVEN BACKEND.

    The suffix is per-backend because the same encoding can live under different
    physical names in each store: qdrant's 4-bit set is suffixed (__bnb4) because
    the FP8 re-embed took the un-suffixed names, while weaviate/chroma were never
    re-embedded so their 4-bit data is still the base name. When weaviate/chroma
    are re-embedded the mapping INVERTS for them — hence a map, not a scalar.
    '' means "use the base name".
    """
    man = fingerprint_manifest()
    fp = embed_fingerprint(base_url, model_id)
    entry = (man.get("by_fingerprint") or {}).get(fp)
    if entry:
        sfx = entry.get("suffix", "")
        if isinstance(sfx, dict):
            return sfx.get(backend, "") or ""
        return sfx or ""          # tolerate the older scalar form
    if fp:
        print(f"[unified-memory] WARNING: embed fingerprint {fp} is not in "
              f"{FINGERPRINT_FILE}; using the base collection names for "
              f"{backend}. Vectors may not match the query encoder.")
    dflt = man.get("default_suffix", "")
    if isinstance(dflt, dict):
        return dflt.get(backend, "") or ""
    return dflt or ""


_qdrant_exists_cache: dict = {}


def qdrant_collection(db: dict, name: str = "") -> str:
    """Qdrant collection name for the ACTIVE embedder.

    Falls back to the unsuffixed name if the fingerprinted twin does not exist
    (e.g. a collection created after the fingerprinting was introduced), so a
    missing twin degrades to today's behaviour instead of 404-ing.
    """
    base = name or COLLECTION_NAME
    sfx = collection_suffix("qdrant")
    if not sfx:
        return base
    cand = f"{base}{sfx}"
    key = f"{db['host']}:{db['port']}/{cand}"
    now = time.time()
    hit = _qdrant_exists_cache.get(key)
    if hit and hit[1] > now:
        return cand if hit[0] else base
    ok = False
    try:
        r = get_client().get(f"http://{db['host']}:{db['port']}/collections/{cand}", timeout=6.0)
        ok = r.status_code == 200
    except Exception:
        ok = False
    _qdrant_exists_cache[key] = (ok, now + _FP_TTL)
    return cand if ok else base


# ─── Embedding ───────────────────────────────────────────────────────────────

def vectorize(texts: list[str]) -> list[list[float]]:
    """Vectorize text using the ProxLab embed proxy."""
    client = get_client()
    cfg = rag_model_cfg()
    try:
        resp = client.post(
            cfg["embed_url"],
            json={"model": cfg["embed_model"], "input": texts},
            timeout=60.0,
        )
        resp.raise_for_status()
        data = resp.json()
        vecs = [d["embedding"] for d in data.get("data", [])]
        if len(vecs) == len(texts):
            _degraded("embed", True)
        else:
            # HTTP 200 with the wrong number of vectors is still a failure —
            # every caller treats a short result as "failed to vectorize".
            _degraded("embed", False,
                      "Embeddings are failing — recall degraded to hippo-only, writes not vectorised",
                      f"embed endpoint returned {len(vecs)} vectors for {len(texts)} inputs (HTTP 200).")
        # A model swap that changes dimensionality invalidates every existing
        # collection; make that loud instead of letting writes fail obscurely.
        if vecs and len(vecs[0]) != EMBED_DIM:
            print(
                f"[unified-memory] WARNING: embed model {cfg['embed_model']} returned dim "
                f"{len(vecs[0])} but collections expect {EMBED_DIM}"
            )
        return vecs
    except Exception as e:
        print(f"[unified-memory] Embedding failed: {e}")
        _degraded("embed", False,
                  "Embeddings are failing — recall degraded to hippo-only, writes not vectorised",
                  f"{e}. consensus_recall skips every vector lane without a query vector, so answers "
                  "arrive looking normal, just thin — the one-lane-dead-another-covers shape.")
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


def write_to_qdrant(client: httpx.Client, db: dict, memory_id: str, vector: list, payload: dict, collection: str = "") -> bool:
    try:
        int_id = stable_point_id(memory_id)
        resp = client.put(
            f"http://{db['host']}:{db['port']}/collections/{qdrant_collection(db, collection)}/points",
            json={"points": [{"id": int_id, "vector": vector, "payload": {**payload, "_memory_id": memory_id}}]},
            timeout=10.0,
        )
        return resp.status_code < 400
    except Exception as e:
        print(f"[unified-memory] Qdrant write failed: {e}")
        return False


def write_to_milvus(client: httpx.Client, db: dict, memory_id: str, vector: list, payload: dict, collection: str = "") -> bool:
    try:
        resp = client.post(
            f"http://{db['host']}:{db['port']}/v2/vectordb/entities/insert",
            json={
                "collectionName": collection or COLLECTION_NAME,
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


def write_to_weaviate(client: httpx.Client, db: dict, memory_id: str, vector: list, payload: dict, collection: str = "") -> bool:
    try:
        _cname = collection or COLLECTION_NAME
        weaviate_class = _cname[0].upper() + _cname[1:]
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


def write_to_chromadb(client: httpx.Client, db: dict, memory_id: str, vector: list, payload: dict, collection: str = "") -> bool:
    try:
        # Get collection ID
        cols_resp = client.get(
            f"http://{db['host']}:{db['port']}/api/v2/tenants/default_tenant/databases/default_database/collections",
            timeout=5.0,
        )
        cols = cols_resp.json()
        col = next((c for c in cols if c["name"] == (collection or COLLECTION_NAME)), None)
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
    """Write a vector to all configured DBs. Returns per-DB status.

    The single WAL entry appended here also durably records the intent for the
    HippocampAI write, which is fired asynchronously (see _fire_async_hippo) so
    the caller never blocks on hippo's flaky, non-WAL REST endpoint.
    """
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

    # Best-effort async write to HippocampAI, tracked under the same wal_id.
    _fire_async_hippo(wal_id, payload)

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


def _hippo_write_from_payload(payload: dict) -> bool:
    """Attempt one HippocampAI write from a WAL payload. True on success."""
    r = write_to_hippocampai(
        payload.get("text", ""),
        payload.get("type", "fact"),
        payload.get("importance", 7.0),
        payload.get("tags", []) or [],
        payload.get("user_id", ""),
    )
    return bool(r)


def _fire_async_hippo(wal_id: int, payload: dict) -> None:
    """Fire-and-forget the hippo write with retries; mark WAL-applied on success.

    Durability comes from the WAL entry already appended by write_to_all_dbs —
    if this thread dies (e.g. process restart) the entry stays unapplied and
    sync_pending() replays it once it ages past HIPPO_GRACE_SEC.
    """
    def _run():
        for attempt in range(HIPPO_RETRIES):
            if _hippo_write_from_payload(payload):
                wal.mark_applied("hippocampai", wal_id)
                return
            time.sleep(1.5 * (attempt + 1))
        print(f"[unified-memory] HippocampAI async write still pending (wal {wal_id})")

    threading.Thread(target=_run, daemon=True).start()


def recall_from_hippocampai(query: str, k: int, user_id: str) -> list:
    """Recall from HippocampAI — returns pre-ranked results with BM25 + reranking.

    Bounded by HIPPO_RECALL_TIMEOUT: hippo does a local-CPU query embed + cross-encoder
    rerank, so under load it can be slow. A short timeout keeps a slow hippo from blocking
    the whole consensus — the vector + OpenViking lanes still answer. Best-effort lane."""
    client = get_client()
    try:
        resp = client.post(
            f"{HIPPOCAMPAI_URL}/v1/memories:recall",
            # rerank=false: skip hippo's local cross-encoder rerank (7-10s on CPU) and take its
            # raw top-k candidates (~80ms). Redundant here anyway — the consensus is reranked with
            # Nemotron below. Turns hippo from the slowest lane into the fastest.
            json={"query": query, "user_id": user_id or _current_user(), "k": k, "rerank": False},
            timeout=HIPPO_RECALL_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data if isinstance(data, list) else data.get("results", [data])
        out = []
        for r in results:
            mem = r.get("memory", r) if isinstance(r, dict) else r
            if isinstance(mem, dict):
                out.append({
                    "text": mem.get("text", "")[:SEARCH_TEXT_LIMIT],
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


# ─── OpenViking recall lane ──────────────────────────────────────────────────

_openviking_healthy: Optional[bool] = None


# Per-agent OpenViking keys (Model B): each agent's key is access-scoped to viking://user/<agent>,
# so recalling with that key returns ONLY that agent's memories — clean per-agent isolation with no
# target_uri/root. The {agent_name: key} map is written by AI-Lab's agent-creation flow; we hot-
# reload it (15s TTL) so a newly-provisioned agent gets scoped recall without restarting this MCP.
_OVK_PATH = os.environ.get("OPENVIKING_AGENT_KEYS_FILE", "/opt/mcp-unified-memory/ov_agent_keys.json")
_ovk_cache = {"keys": {}, "ts": 0.0}


def _ov_agent_keys() -> dict:
    now = time.time()
    if _ovk_cache["keys"] and (now - _ovk_cache["ts"]) < 15.0:
        return _ovk_cache["keys"]
    try:
        if os.path.exists(_OVK_PATH):
            with open(_OVK_PATH) as _f:
                _ovk_cache["keys"] = json.load(_f) or {}
    except Exception:
        pass
    _ovk_cache["ts"] = now
    return _ovk_cache["keys"]


def _openviking_key_for(user_id: str) -> str:
    """The composite recalls with user_id='agent:<agent>'. Return that agent's own (scoped) key so
    find sees only its user/<agent> memories; fall back to the shared default key otherwise."""
    uid = (user_id or "").strip()
    agent = uid.split("agent:", 1)[1].strip() if uid.startswith("agent:") else ""
    return _ov_agent_keys().get(agent) or OPENVIKING_API_KEY


def _openviking_headers(user_id: str = "") -> dict:
    # Both key forms, matching Hermes' bundled OpenViking provider. The KEY carries account/user
    # tenancy AND read scope — a per-agent key limits recall to that agent's own memories.
    key = _openviking_key_for(user_id)
    return {"X-API-Key": key, "Authorization": f"Bearer {key}"}


def openviking_enabled() -> bool:
    """OpenViking is a lane only if a key is configured and it health-checks.
    The health probe is cached so recall stays fast; None = not yet probed."""
    global _openviking_healthy
    if not OPENVIKING_API_KEY:
        return False
    if _openviking_healthy is None:
        try:
            r = get_client().get(f"{OPENVIKING_URL}/health", timeout=4.0)
            _openviking_healthy = r.status_code == 200
        except Exception:
            _openviking_healthy = False
    return bool(_openviking_healthy)


def search_openviking(query: str, k: int, user_id: str) -> list:
    """Search OpenViking's content index as one RRF lane. Read-only; best-effort.

    Uses /api/v1/search/find (OpenViking's passive-recall endpoint, the same one
    the Hermes composite plugin uses for prefetch). Response is
    {result: {memories: [...], resources: [...]}} with each item {uri, score,
    abstract}. Any shape mismatch is caught and the lane contributes nothing,
    never breaking the overall recall.
    """
    if not openviking_enabled():
        return []
    client = get_client()
    try:
        resp = client.post(
            f"{OPENVIKING_URL}/api/v1/search/find",
            json={"query": query, "limit": k},
            headers=_openviking_headers(user_id), timeout=15.0,
        )
        resp.raise_for_status()
        result = (resp.json() or {}).get("result", {})
        out = []
        rank = 0
        for ctx_type in ("memories", "resources"):
            for item in result.get(ctx_type, []) or []:
                if not isinstance(item, dict):
                    continue
                uri = item.get("uri") or ""
                # Skip OpenViking's structural stubs (directory overviews /
                # abstracts, dotfiles) — they're navigation metadata, not memories.
                base = uri.rstrip("/").rsplit("/", 1)[-1]
                if base.startswith(".") or base in ("_overview.md", "overview.md"):
                    continue
                abstract = item.get("abstract") or item.get("text") or ""
                if not abstract or "[Directory overview is not generated]" in abstract:
                    continue
                rank += 1
                out.append({
                    "text": str(abstract)[:SEARCH_TEXT_LIMIT],
                    "score": item.get("score", 0),
                    "id": item.get("uri", ""),
                    "source": "openviking",
                    "rank": rank,
                    "metadata": {"user_id": user_id, "uri": item.get("uri"), "ov_type": ctx_type},
                })
        return out
    except Exception as e:
        print(f"[unified-memory] OpenViking search failed: {e}")
        return []


# ─── Vector DB Search ────────────────────────────────────────────────────────

def search_qdrant(client: httpx.Client, db: dict, query_vector: list, k: int, collection: str = "") -> list:
    try:
        resp = client.post(
            f"http://{db['host']}:{db['port']}/collections/{qdrant_collection(db, collection)}/points/query",
            json={"query": query_vector, "limit": k, "with_payload": True},
            timeout=15.0,
        )
        data = resp.json()
        return [
            {"text": p.get("payload", {}).get("text", "")[:SEARCH_TEXT_LIMIT], "score": p.get("score", 0),
             "id": p.get("payload", {}).get("_memory_id", str(p.get("id", ""))),
             "source": "qdrant", "rank": i + 1, "metadata": p.get("payload", {})}
            for i, p in enumerate(data.get("result", {}).get("points", []))
        ]
    except Exception as e:
        print(f"[unified-memory] Qdrant search failed: {e}")
        return []


def search_milvus(client: httpx.Client, db: dict, query_vector: list, k: int, collection: str = "") -> list:
    try:
        resp = client.post(
            f"http://{db['host']}:{db['port']}/v2/vectordb/entities/search",
            json={"collectionName": collection or COLLECTION_NAME, "data": [query_vector], "annsField": "vector",
                  "limit": k, "outputFields": ["text", "_memory_id", "user_id"]},
            timeout=15.0,
        )
        data = resp.json()
        return [
            {"text": p.get("text", "")[:SEARCH_TEXT_LIMIT], "score": p.get("distance", 0),
             "id": p.get("_memory_id", str(p.get("id", ""))),
             "source": "milvus", "rank": i + 1, "metadata": {"user_id": p.get("user_id", "")}}
            for i, p in enumerate(data.get("data", []))
        ]
    except Exception as e:
        print(f"[unified-memory] Milvus search failed: {e}")
        return []


def search_weaviate(client: httpx.Client, db: dict, query_vector: list, k: int, collection: str = "") -> list:
    try:
        _cname = collection or COLLECTION_NAME
        weaviate_class = _cname[0].upper() + _cname[1:]
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
                {"text": p.get("text", "")[:SEARCH_TEXT_LIMIT], "score": 1 - (p.get("_additional", {}).get("distance", 0)),
                 "id": p.get("memory_id", p.get("_additional", {}).get("id", "")),
                 "source": "weaviate", "rank": i + 1, "metadata": {"user_id": owner}})
        return out
    except Exception as e:
        print(f"[unified-memory] Weaviate search failed: {e}")
        return []


def search_chromadb(client: httpx.Client, db: dict, query_vector: list, k: int, collection: str = "") -> list:
    try:
        cols_resp = client.get(
            f"http://{db['host']}:{db['port']}/api/v2/tenants/default_tenant/databases/default_database/collections",
            timeout=5.0,
        )
        cols = cols_resp.json()
        col = next((c for c in cols if c["name"] == (collection or COLLECTION_NAME)), None)
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
            {"text": docs[i][:SEARCH_TEXT_LIMIT] if i < len(docs) else "", "score": 1 - (dists[i] if i < len(dists) else 0),
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
        cfg = rag_model_cfg()
        resp = client.post(
            cfg["rerank_url"],
            json={"model": cfg["rerank_model"], "query": query, "documents": documents},
            timeout=15.0,
        )
        if resp.status_code != 200:
            # This branch was FULLY silent — not even a print — while returning
            # the un-reranked order as if nothing happened.
            _degraded("reranker", False,
                      "Recall reranker is down — results served in raw RRF order",
                      f"HTTP {resp.status_code} from {cfg['rerank_url']}. Every recall in the fleet "
                      "is degraded to fused-but-unreranked order; answers look normal, just worse. "
                      "The reranker has died unnoticed before (10.0.0.140 decommission).")
            return results

        reranked = resp.json().get("results", [])
        score_map = {r["index"]: r["relevance_score"] for r in reranked}

        # Map scores back to results
        text_results = [r for r in results if r.get("text")]
        for i, r in enumerate(text_results):
            r["reranker_score"] = score_map.get(i, 0)

        _degraded("reranker", True)
        return sorted(text_results, key=lambda x: x.get("reranker_score", 0), reverse=True)
    except Exception as e:
        print(f"[unified-memory] Reranking failed: {e}")
        _degraded("reranker", False,
                  "Recall reranker is unreachable — results served in raw RRF order",
                  f"{e}. Every recall in the fleet is degraded; the outage is invisible at the "
                  "recall surface because answers still arrive.")
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

    # 2b. Search OpenViking (content engine) as an extra lane — no-op unless
    # configured + healthy. Fed by the Hermes auto-extraction path, so this is
    # where Hermes-extracted memories join the unified recall.
    ov_results = search_openviking(query, k, user_id)
    if ov_results:
        results_by_source["openviking"] = ov_results

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

def sync_pending(include_hippo: bool = True, batch: int = SYNC_BATCH):
    """Replay pending WAL entries to any DB that missed writes.

    Bounded by `batch` per backend so a large backlog can't make a single call
    slow. `include_hippo=False` skips the slow hippo replay entirely — used on
    the remember() hot path (hippo replays only in the background drainer), so a
    hippo backlog never makes a store slow. The backlog drains over time."""
    client = get_client()
    synced = 0
    for db in VECTOR_DBS:
        pending = wal.get_pending(db["name"])
        if not pending:
            continue
        writer = WRITERS.get(db["type"])
        if not writer:
            continue
        for entry in pending[:batch]:
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

    # Replay HippocampAI writes that never got applied — but only once they've
    # aged past the grace window, so we don't race the live _fire_async_hippo
    # thread and double-write the same fact. Bounded + background-only (each
    # replay hits hippo's slow 9B conflict-check, so this must never run inline
    # on a store).
    if include_hippo:
        now = time.time()
        done = 0
        for entry in wal.get_pending("hippocampai"):
            if done >= batch:
                break
            if entry.get("op") != "upsert":
                continue
            if now - entry.get("_timestamp", 0) < HIPPO_GRACE_SEC:
                continue
            if _hippo_write_from_payload(entry.get("payload", {})):
                wal.mark_applied("hippocampai", entry["_wal_id"])
                synced += 1
                done += 1

    if synced:
        print(f"[unified-memory] Synced {synced} pending writes")
    return synced


def _sync_worker() -> None:
    """Background drainer: periodically replays the WAL backlog (incl. the slow
    hippo lane) off the request path so stores stay fast."""
    while True:
        time.sleep(SYNC_INTERVAL)
        try:
            sync_pending(include_hippo=True)
            wal.compact()
            # The backlog check memory_health computed for nobody: per backend,
            # latched via _degraded (3 consecutive over-threshold passes fire
            # once; a drained backlog re-arms with an info).
            for _db in VECTOR_DBS:
                _n = len(wal.get_pending(_db["name"]))
                _degraded(f"wal-{_db['name']}", _n <= WAL_BACKLOG_THRESHOLD,
                          f"Memory writes are backing up for {_db['name']}",
                          f"{_n} unapplied WAL entries (threshold {WAL_BACKLOG_THRESHOLD}). The backend is not absorbing "
                          "writes; they are safe in the WAL (compact never drops unapplied entries) but recall on this "
                          "lane is increasingly stale, and the file grows until the backend recovers.")
        except Exception as e:  # noqa: BLE001
            print(f"[unified-memory] sync worker error: {e}")


# ─── MCP Tools ───────────────────────────────────────────────────────────────

def _remember_impl(
    text: str,
    type: str = "fact",
    importance: float = 7.0,
    tags: str = "",
    user_id: str = "",
) -> dict:
    """Core store logic shared by the MCP `remember` tool and the REST facade."""
    memory_id = str(uuid.uuid4())
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []

    # 1. Vectorize
    vecs = vectorize([text])
    if not vecs:
        return {"error": "Failed to vectorize text"}

    payload = {
        "text": text,
        "type": type,
        "importance": importance,
        "tags": tag_list,
        "user_id": user_id or _current_user(),
        "memory_id": memory_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # 2. Write to all vector DBs (this also fires the async, WAL-backed hippo write)
    db_results = write_to_all_dbs(memory_id, vecs[0], payload)

    # 3. Fast: replay only vector-DB backlog inline (cheap). The slow hippo
    # backlog is drained by the background worker, never on the store path.
    sync_pending(include_hippo=False)

    successful = sum(1 for v in db_results.values() if v)
    total = len(db_results)

    return {
        "id": memory_id,
        "text": text[:200],
        "type": type,
        "importance": importance,
        "replicated_to": f"{successful}/{total} vector backends",
        "backends": {**db_results, "hippocampai": "queued (async)"},
    }


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
    result = _remember_impl(text, type, importance, tags, user_id)
    return json.dumps(result, indent=2)


@mcp.tool()
def recall(
    query: str,
    k: int = 10,
    user_id: str = "",
) -> str:
    """Recall memories using consensus search across all vector databases.

    Searches HippocampAI (with BM25 + its own reranking) and all vector DBs,
    merges results with Reciprocal Rank Fusion, then reranks with Nemotron.

    NOTE: relevant memories are auto-injected each turn. For a deliberate/manual lookup that
    needs the FULL memory text (not a preview), use `memory_search` instead.

    Args:
        query: Natural language query.
        k: Number of results (default 10, max 50).
        user_id: User namespace (default: "claude").
    """
    return json.dumps(_recall_impl(query, k, user_id), indent=2)


def _recall_impl(query: str, k: int = 10, user_id: str = "") -> list:
    """Core recall logic shared by the MCP `recall` tool and the REST facade."""
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
    return output


@mcp.tool()
def memory_search(
    query: str,
    k: int = 10,
    max_chars: int = 0,
    user_id: str = "",
) -> str:
    """Manually search your long-term memory and get the FULL memory text back.

    Same consensus engine as automatic recall (HippocampAI + OpenViking + all vector DBs, merged
    with RRF and reranked), but this returns complete memory content instead of a short preview.

    Relevant memories are already auto-injected into your context every turn, so you don't normally
    need this. Use it for a DELIBERATE dig: the user asked you to look something up, or you need the
    full detail of a memory the injected preview only hinted at.

    Args:
        query: Natural language query.
        k: Number of results (default 10, max 50).
        max_chars: Optional per-record character cap to conserve context. 0 = full text (default).
                   If a record is trimmed the result carries truncated=true + full_length, so you
                   always know more exists (nothing is silently cut).
        user_id: User namespace (default: your own).
    """
    results = consensus_recall(query, min(k, 50), user_id or _current_user())
    output = []
    for i, r in enumerate(results):
        full = r.get("text", "") or ""
        text = full if max_chars <= 0 else full[:max_chars]
        row = {
            "rank": i + 1,
            "text": text,
            "score": round(r.get("reranker_score", r.get("rrf_score", 0)), 4),
            "sources": r.get("sources", []),
            "consensus": len(r.get("sources", [])),
            "type": r.get("type"),
            "importance": r.get("importance"),
            "tags": r.get("tags", []),
            "id": r.get("id"),
        }
        if max_chars > 0 and len(full) > max_chars:
            row["truncated"] = True
            row["full_length"] = len(full)
        output.append(row)
    return json.dumps({"query": query, "count": len(output), "results": output}, indent=2)


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
        # rag_model_cfg()["rerank_url"] is what rerank() ACTUALLY calls;
        # probing the env default here let the health check read green against
        # an endpoint the live path never touches (and vice versa).
        resp = client.post(rag_model_cfg()["rerank_url"],
                           json={"query": "test", "documents": ["test"]}, timeout=5.0)
        health["reranker"] = {"healthy": resp.status_code == 200}
    except Exception as e:
        health["reranker"] = {"healthy": False, "error": str(e)}

    # OpenViking recall lane (read-only; disabled unless keyed + healthy)
    if not OPENVIKING_API_KEY:
        health["openviking"] = {"healthy": False, "lane": "disabled (no OPENVIKING_API_KEY)"}
    else:
        try:
            resp = client.get(f"{OPENVIKING_URL}/health", timeout=5.0)
            health["openviking"] = {"healthy": resp.status_code == 200, "lane": "recall"}
        except Exception as e:
            health["openviking"] = {"healthy": False, "error": str(e)}

    # WAL status — vector DBs plus the async hippocampai lane
    state = wal.get_db_state()
    pending_counts = {db["name"]: len(wal.get_pending(db["name"])) for db in VECTOR_DBS}
    pending_counts["hippocampai"] = len(wal.get_pending("hippocampai"))
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
            # collection rides as an ARGUMENT — the old globals() swap raced
            # concurrent HTTP requests (uvicorn serves in parallel): a main-memory
            # write landing during the swap window was silently misfiled into the
            # custom collection.
            ok = writer(client, db, doc_id, vecs[0], payload, collection=collection)
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
            # collection as an ARGUMENT — same race as the writer-side swap:
            # a concurrent main-memory search during the swap window silently
            # searched the wrong collection.
            db_results = searcher(client, db, query_vector, k, collection=collection)
            if db_results:
                results_by_source[db["name"]] = db_results

    if not results_by_source:
        return json.dumps({"collection": collection, "results": [], "message": "No results found"})

    fused = reciprocal_rank_fusion(results_by_source)
    reranked = rerank(query, fused[:k * 2])

    output = [{
        "rank": i + 1,
        "text": r.get("text", "")[:SEARCH_TEXT_LIMIT],
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

    # Background WAL drainer — replays the (slow) hippo backlog off the request path.
    threading.Thread(target=_sync_worker, daemon=True).start()

    mcp.settings.stateless_http = True
    # LAN service: accept Host headers for this box's addresses (the default
    # DNS-rebinding guard only allows localhost, which 421s the mcpjungle
    # gateway and any /u/<name>/mcp caller using the LAN IP).
    from mcp.server.transport_security import TransportSecuritySettings
    import socket as _sock
    def _lan_ip():
        try:
            _s = _sock.socket(_sock.AF_INET, _sock.SOCK_DGRAM); _s.connect(("10.255.255.255", 1))
            _ip = _s.getsockname()[0]; _s.close(); return _ip
        except Exception:
            return "127.0.0.1"
    allowed = ["127.0.0.1:*", "localhost:*"]
    for h in (os.environ.get("MEMORY_MCP_ALLOWED_HOSTS") or _lan_ip()).split(","):
        h = h.strip()
        if h:
            allowed.append(f"{h}:*")
    mcp.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True, allowed_hosts=allowed)
    app = mcp.streamable_http_app()
    path_re = re.compile(r"^/u/([A-Za-z0-9_.:-]+)(/.*)$")

    async def _read_body(receive) -> bytes:
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        return body

    async def _send_json(send, obj, status: int = 200) -> None:
        data = json.dumps(obj).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(data)).encode())]})
        await send({"type": "http.response.body", "body": data})

    # Plain-HTTP REST facade so stdlib-only clients (e.g. the Hermes composite
    # memory plugin) can reach recall/remember without an MCP session. Namespace
    # comes from the JSON body's user_id, or the /u/<name>/ path prefix.
    async def _rest(path: str, receive, send) -> None:
        try:
            payload = json.loads((await _read_body(receive)) or b"{}")
        except Exception:
            return await _send_json(send, {"error": "invalid JSON body"}, 400)
        uid = payload.get("user_id") or _CALLER_USER.get() or ""
        if path == "/rest/recall":
            out = _recall_impl(payload.get("query", ""), int(payload.get("k", 10) or 10), uid)
            return await _send_json(send, {"results": out})
        if path == "/rest/remember":
            out = _remember_impl(
                payload.get("text", ""), payload.get("type", "fact"),
                float(payload.get("importance", 7.0) or 7.0),
                payload.get("tags", "") or "", uid)
            return await _send_json(send, out)
        return await _send_json(send, {"error": f"unknown rest path {path}"}, 404)

    async def routed(scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            m = path_re.match(path)
            if m:
                _CALLER_USER.set(m.group(1))
                path = m.group(2)
                scope = dict(scope)
                scope["path"] = path
                scope["raw_path"] = path.encode()
            else:
                _CALLER_USER.set("")
            if path.startswith("/rest/"):
                return await _rest(path, receive, send)
        await app(scope, receive, send)

    uvicorn.run(routed, host="0.0.0.0", port=port, lifespan="on", log_level="warning")
