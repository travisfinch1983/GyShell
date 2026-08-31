"""HippocampAI memory provider for Hermes — the AI-Lab fleet memory tier.

Bridges Hermes' native MemoryProvider hooks (agent/memory_provider.py) to the
lab's HippocampAI service ("Advanced Intelligence APIs", default
http://10.0.0.219:8010 — the docker instance) — the same backend the
unified-memory MCP fronts, so
explicit MCP remember/recall and this seamless tier share one store.

Seamless behavior (no agent ceremony):
  - prefetch(): background recall injected before each turn (cache filled by
    queue_prefetch after the previous turn; cold turns do one short-timeout
    synchronous recall).
  - sync_turn(): buffers turns; every EXTRACT_EVERY turns the buffered chunk
    goes to POST /v1/memories:extract (server-side fact extraction + dedup —
    HippocampAI owns consolidation/compaction, so we don't re-implement it).
  - on_session_end()/on_pre_compress(): flush the remaining buffer so nothing
    is lost at session boundaries or compression.
  - on_memory_write(): mirrors built-in MEMORY.md/USER.md writes as
    high-importance memories.
  - on_delegation(): records what was delegated and what came back.

Per-agent scoping: user_id = "agent:<agent_identity>" (the Hermes profile
name), so each of the ~9 agents gets its own memory space in the shared
backend; set HIPPOCAMPAI_USER_ID (or hippocampai.json user_id) to override.
Writes are skipped for non-primary contexts (cron/subagent) per the ABC's
guidance; recall still works there.

Zero dependencies beyond the stdlib (urllib) — deliberately, so the plugin
drops into any profile without touching the Hermes venv. Circuit breaker
pauses calls after repeated failures so a down backend never stalls turns.

Install (per agent profile):
  $HERMES_HOME/plugins/hippocampai/__init__.py   (this file)
  config.yaml → memory: provider: hippocampai
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_SECS = 120

_DEFAULTS = {
    # Default = the docker instance on the ai-lab CT (host port 8010). The old
    # default, 10.0.0.26:8000, was the CT26 venv install — DECOMMISSIONED
    # 2026-08-31 (corpus migrated; CT stopped): that address answers nothing.
    "url": os.environ.get("HIPPOCAMPAI_URL", "http://10.0.0.219:8010"),
    "user_id": os.environ.get("HIPPOCAMPAI_USER_ID", ""),
    "recall_k": int(os.environ.get("HIPPOCAMPAI_RECALL_K", "5") or 5),
    "extract_every": int(os.environ.get("HIPPOCAMPAI_EXTRACT_EVERY", "5") or 5),
}

RECALL_TOOL = {
    "name": "memory_recall_deep",
    "description": (
        "Search your persistent long-term memory (HippocampAI) for facts, events and "
        "preferences from past sessions. Relevant memories are already injected "
        "automatically each turn — use this only to dig deeper on a specific topic."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for."},
            "k": {"type": "integer", "description": "Max results (default 8)."},
        },
        "required": ["query"],
    },
}

REMEMBER_TOOL = {
    "name": "memory_remember",
    "description": (
        "Store an important fact in persistent long-term memory (HippocampAI). "
        "Routine conversation is captured automatically — use this for things "
        "explicitly worth pinning (user preferences, decisions, standing facts)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "The fact to remember."},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional tags."},
        },
        "required": ["text"],
    },
}


def _load_config(hermes_home: str = "") -> dict:
    cfg = dict(_DEFAULTS)
    path = os.path.join(hermes_home or os.path.expanduser("~/.hermes"), "hippocampai.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            file_cfg = json.load(f)
        cfg.update({k: v for k, v in file_cfg.items() if v not in (None, "")})
    except FileNotFoundError:
        pass  # no override file — defaults are the configured state
    except Exception as e:
        # A CORRUPT file silently falling back is the dangerous one: defaults
        # include a different user_id, so every write lands in the wrong
        # memory namespace while everything looks fine.
        logger.warning("hippocampai: config %s unreadable — DEFAULTS in use "
                       "(including the default user_id namespace): %s", path, e)
    return cfg


class HippocampAIProvider(MemoryProvider):
    """Seamless fleet memory backed by the lab's HippocampAI service."""

    def __init__(self) -> None:
        self._cfg = _load_config()
        self._user_id = ""
        self._session_id = ""
        self._primary = True
        self._lock = threading.Lock()
        self._prefetched: str = ""
        self._prefetch_query: str = ""
        self._turn_buffer: List[str] = []
        self._failures = 0
        self._breaker_until = 0.0
        self._dropped_while_open = 0

    # -- identity ------------------------------------------------------------

    @property
    def name(self) -> str:
        return "hippocampai"

    @property
    def description(self) -> str:
        return "AI-Lab HippocampAI service — seamless per-agent fleet memory (LAN, self-hosted)"

    # -- http plumbing ---------------------------------------------------------

    def _post(self, path: str, body: Dict[str, Any], timeout: float = 8.0) -> Optional[Any]:
        if time.time() < self._breaker_until:
            self._dropped_while_open += 1
            return None
        req = urllib.request.Request(
            self._cfg["url"].rstrip("/") + path,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                self._failures = 0
                if self._dropped_while_open:
                    # The breaker window used to swallow calls with no trace —
                    # recovery is where the bill gets read out.
                    logger.warning("hippocampai: circuit closed — %s calls were dropped while it was open",
                                   self._dropped_while_open)
                    self._dropped_while_open = 0
                raw = r.read()
                return json.loads(raw) if raw else None
        except Exception as e:  # noqa: BLE001 — any failure feeds the breaker
            self._failures += 1
            if self._failures >= _BREAKER_THRESHOLD:
                self._breaker_until = time.time() + _BREAKER_COOLDOWN_SECS
                logger.warning("hippocampai: circuit open for %ss after %s failures (%s)",
                               _BREAKER_COOLDOWN_SECS, self._failures, e)
            else:
                logger.debug("hippocampai: request failed: %s", e)
            return None

    def _bg(self, fn, *args) -> None:
        threading.Thread(target=fn, args=args, daemon=True).start()

    # -- core lifecycle --------------------------------------------------------

    def is_available(self) -> bool:
        # Config-only check per the ABC (no network): a URL is always present
        # (LAN default), so the provider is available unless explicitly unset.
        return bool(self._cfg.get("url"))

    def initialize(self, session_id: str, **kwargs) -> None:
        self._cfg = _load_config(kwargs.get("hermes_home", ""))
        self._session_id = session_id
        agent = kwargs.get("agent_identity", "") or "hermes"
        self._user_id = self._cfg.get("user_id") or f"agent:{agent}"
        # cron/subagent contexts read but never write (their system prompts
        # would pollute the agent's memory) — per the ABC's guidance.
        self._primary = kwargs.get("agent_context", "primary") in ("primary", "")
        logger.info("hippocampai: initialized user_id=%s session=%s primary=%s",
                    self._user_id, session_id, self._primary)

    def system_prompt_block(self) -> str:
        return (
            "Persistent memory: ACTIVE (HippocampAI). Relevant memories from past "
            "sessions are injected automatically each turn; important facts are "
            "captured automatically. Use memory_recall_deep to search further and "
            "memory_remember to pin something explicitly."
        )

    # -- recall (prefetch cache pattern from the ABC docstring) ----------------

    def _recall(self, query: str, k: int) -> List[Dict[str, Any]]:
        res = self._post("/v1/memories:recall", {
            "query": query[:2000],
            "user_id": self._user_id,
            "k": k,
        })
        if isinstance(res, list):
            return res
        if isinstance(res, dict):
            return res.get("results") or res.get("memories") or []
        return []

    @staticmethod
    def _format(memories: List[Dict[str, Any]]) -> str:
        lines = []
        for m in memories:
            # recall items nest the record under "memory" (live shape 2026-07-07)
            inner = m.get("memory") if isinstance(m.get("memory"), dict) else m
            text = str(inner.get("text") or inner.get("content") or "").strip()
            if text:
                lines.append(f"- {text}")
        if not lines:
            return ""
        return "Relevant long-term memories:\n" + "\n".join(lines[:12])

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        with self._lock:
            if self._prefetched and self._prefetch_query == query:
                out = self._prefetched
                self._prefetched = ""
                return out
            if self._prefetched:
                # Prefetched for a DIFFERENT query — serving it anyway handed
                # the model memories about the wrong topic, silently. Discard
                # and do the honest cold recall below.
                logger.debug("hippocampai: discarding stale prefetch (was for %r)", self._prefetch_query)
                self._prefetched = ""
        # cold turn: one short synchronous recall so the first turn still sees memory
        return self._format(self._recall(query, self._cfg["recall_k"]))

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        def work() -> None:
            out = self._format(self._recall(query, self._cfg["recall_k"]))
            with self._lock:
                self._prefetched = out
                self._prefetch_query = query
        self._bg(work)

    # -- capture ----------------------------------------------------------------

    def _flush_buffer(self, *, sync: bool = False) -> None:
        with self._lock:
            if not self._turn_buffer:
                return
            chunk = "\n".join(self._turn_buffer)
            self._turn_buffer = []
        body = {"conversation": chunk[:24000], "user_id": self._user_id,
                "session_id": self._session_id}
        if sync:
            if self._post("/v1/memories:extract", body, timeout=180.0) is None:
                logger.warning("hippocampai: memory extraction FAILED — this turn's memories were not captured")
        else:
            def _extract() -> None:
                if self._post("/v1/memories:extract", body, 180.0) is None:
                    logger.warning("hippocampai: background memory extraction FAILED — this turn's memories were not captured")
            self._bg(_extract)

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", messages: Optional[List[Dict[str, Any]]] = None) -> None:
        if not self._primary:
            return
        with self._lock:
            self._turn_buffer.append(f"User: {user_content}\nAssistant: {assistant_content}")
            ready = len(self._turn_buffer) >= self._cfg["extract_every"]
        if ready:
            self._flush_buffer()

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        if self._primary:
            self._flush_buffer(sync=True)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        # extract whatever we've buffered before those turns are discarded;
        # nothing extra to add to the compression prompt itself.
        if self._primary:
            self._flush_buffer()
        return ""

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "",
                          reset: bool = False, rewound: bool = False, **kwargs) -> None:
        if reset and self._primary:
            self._flush_buffer()
        self._session_id = new_session_id
        with self._lock:
            self._prefetched = ""
            if reset:
                self._turn_buffer = []

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        # mirror MEMORY.md/USER.md writes as durable, high-importance memories
        if not self._primary or action == "remove" or not content.strip():
            return
        self._bg(self._post, "/v1/memories:remember", {
            "text": content.strip()[:4000],
            "user_id": self._user_id,
            "session_id": self._session_id,
            "importance": 0.9,
            "tags": [f"builtin:{target}"],
        }, 120.0)

    def on_delegation(self, task: str, result: str, *, child_session_id: str = "", **kwargs) -> None:
        if not self._primary:
            return
        with self._lock:
            self._turn_buffer.append(f"Delegated task: {task}\nSubagent result: {result[:2000]}")

    def shutdown(self) -> None:
        self._flush_buffer(sync=True)

    # -- explicit tools (small, optional surface) --------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [RECALL_TOOL, REMEMBER_TOOL]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name == "memory_recall_deep":
            memories = self._recall(str(args.get("query", "")), int(args.get("k", 8) or 8))
            return json.dumps({"results": memories[:12]} if memories
                              else {"results": [], "note": "no matching memories"})
        if tool_name == "memory_remember":
            res = self._post("/v1/memories:remember", {
                "text": str(args.get("text", ""))[:4000],
                "user_id": self._user_id,
                "session_id": self._session_id,
                "tags": list(args.get("tags") or []),
            }, 120.0)
            return json.dumps({"ok": res is not None})
        return json.dumps({"error": f"unknown tool {tool_name}"})

    # -- hermes memory setup ------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "url", "description": "HippocampAI base URL",
             "default": _DEFAULTS["url"], "required": True},
            {"key": "user_id", "description": "Memory user id (empty = agent:<profile>)"},
            {"key": "recall_k", "description": "Memories injected per turn", "default": 5},
            {"key": "extract_every", "description": "Turns buffered per extraction", "default": 5},
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        path = os.path.join(hermes_home, "hippocampai.json")
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(values, f, indent=2)
        except Exception as e:  # noqa: BLE001
            logger.warning("hippocampai: could not write %s: %s", path, e)


PROVIDER_CLASS = HippocampAIProvider
