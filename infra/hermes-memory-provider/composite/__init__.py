"""Composite memory router for Hermes — unified-recall + native-capture.

Rebuild (2026-07-08): RECALL now converges on the unified memory MCP
(10.0.0.219:9847), which fans a single query across HippocampAI + Qdrant +
Weaviate + ChromaDB + OpenViking, merges with Reciprocal Rank Fusion, and
reranks with the Nemotron cross-encoder server-side. This REPLACES the old
per-lane prefetch + local rerank (which pointed at the decommissioned ProxLab
reranker at 10.0.0.140:7777 and had been silently falling back to plain
concatenation). One consensus, one reranker, every backend.

WRITES stay on the native lanes on purpose — each does proper conversational
fact extraction that the atomic MCP `remember` cannot reproduce:
  - hippocampai lane → HippocampAI server-side extraction (/v1/memories:extract)
  - openviking  lane → OpenViking native content capture
Both stores are lanes in the unified recall, so everything captured here is
readable through the single consensus. Nothing is lost by not forwarding raw
writes to the MCP; extraction quality is preserved.

Namespace: recall is scoped to user_id="agent:<agent_identity>" — the SAME key
the hippocampai lane writes under — so the unified recall's HippocampAI lane
sees exactly this agent's memories. (OpenViking is reached in the unified MCP
via a fixed hermes/main key, so its content is shared across agents for now.)

Install (per agent profile):
  $HERMES_HOME/plugins/composite/__init__.py    (this file)
  $HERMES_HOME/plugins/hippocampai/__init__.py  (write lane 1)
  config.yaml → memory: provider: composite
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

# ── notification emitter ────────────────────────────────────────────────────────────────────
# A lane that drops out is INVISIBLE by design: this router isolates lanes so one failure never
# sinks the other, so memory keeps working on the surviving lane and nothing looks wrong. The
# OpenViking lane was dead for twelve days that way — the warning below was written every run,
# to a per-profile log nobody opens. Raise it where a human will see it.
_AILAB_API = os.environ.get("AILAB_API_URL", "http://10.0.0.219:17890")

def _notify(severity, message, detail=""):
    """Best effort. Never raises and never blocks the hot path meaningfully — reporting a
    degraded lane must not be able to degrade anything itself."""
    try:
        body = json.dumps({"severity": severity, "source": "memory-composite",
                           "message": message, "detail": detail}).encode()
        req = urllib.request.Request(_AILAB_API + "/api/notifications/emit", body,
                                     {"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass


_LANES = ("hippocampai", "openviking")
_DEFAULT_OV_ENDPOINT = os.environ.get("OPENVIKING_ENDPOINT", "http://127.0.0.1:1933")
# The unified memory MCP's plain-HTTP recall facade (all backends + rerank).
_UNIFIED_URL = os.environ.get("UNIFIED_MEMORY_URL", "http://10.0.0.219:9847").rstrip("/")
_PREFETCH_DEADLINE_SECS = float(os.environ.get("MEMORY_PREFETCH_DEADLINE", "4.0") or 4.0)
_RECALL_K = int(os.environ.get("MEMORY_RECALL_K", "8") or 8)


# Reasoning-block tags emitted by the think-preserving models in this cluster.
_THINK_TAGS = ("think", "thinking", "reasoning", "thought")
_THINK_PAIR = re.compile(
    r"<\s*(%s)\s*>.*?<\s*/\s*\1\s*>" % "|".join(_THINK_TAGS), re.IGNORECASE | re.DOTALL)
_THINK_CLOSE = re.compile(r"<\s*/\s*(?:%s)\s*>" % "|".join(_THINK_TAGS), re.IGNORECASE)
_THINK_OPEN = re.compile(r"<\s*(?:%s)\s*>" % "|".join(_THINK_TAGS), re.IGNORECASE)


def _strip_reasoning(text: str) -> str:
    """Remove a turn's thinking region, leaving only what the agent actually said.

    Handles the ragged cases, not just well-formed pairs:
      * matched <think>...</think>            -> removed
      * a CLOSING tag with no opener          -> everything before it was thinking
                                                 (the opener was trimmed upstream);
                                                 drop up to and including the last one
      * an OPENING tag with no closer         -> truncated mid-thought; drop to the end
      * any stray bare tag left over          -> removed
    Deliberately conservative: if stripping would leave nothing, keep the original
    rather than feed an empty turn to the extractor.
    """
    if not text:
        return text
    original = text
    out = _THINK_PAIR.sub(" ", text)
    closes = list(_THINK_CLOSE.finditer(out))
    if closes:
        out = out[closes[-1].end():]
    open_m = _THINK_OPEN.search(out)
    if open_m:
        out = out[:open_m.start()]
    out = _THINK_OPEN.sub(" ", _THINK_CLOSE.sub(" ", out)).strip()
    if out:
        return out
    # Nothing survived: the turn was reasoning and nothing else, i.e. the agent
    # never actually said anything. Return empty rather than falling back to the
    # original -- handing the raw thinking to the extractor IS the bug this
    # function exists to fix, and an empty assistant turn is harmless.
    return "" if (_THINK_PAIR.search(original) or _THINK_CLOSE.search(original)
                  or _THINK_OPEN.search(original)) else original.strip()


class CompositeProvider(MemoryProvider):
    """One provider to Hermes; unified-MCP recall + native lane capture."""

    def __init__(self) -> None:
        self._children: Dict[str, MemoryProvider] = {}
        self._hermes_home = ""
        self._session_id = ""
        self._user_id = ""
        self._tool_owner: Dict[str, str] = {}
        self._lock = threading.Lock()
        # (query, text) rather than a bare string: a warm is only valid for the
        # message it was recalled with. See _warm()/prefetch().
        self._prefetched = ("", "")
        self._warming = ""

    @property
    def name(self) -> str:
        return "composite"

    @property
    def description(self) -> str:
        return "AI-Lab memory router — unified-MCP consensus recall + native lane capture"

    # -- fan-out helper (writes / lifecycle / tools) ---------------------------

    def _each(self, method: str, *args, **kwargs) -> Dict[str, Any]:
        """Call method on every write lane, isolating failures per lane."""
        out: Dict[str, Any] = {}
        for lane, child in self._children.items():
            try:
                out[lane] = getattr(child, method)(*args, **kwargs)
            except Exception as e:  # noqa: BLE001 — one lane must not sink the other
                logger.warning("composite: lane %s %s failed: %s", lane, method, e)
        return out

    # -- core lifecycle --------------------------------------------------------

    def is_available(self) -> bool:
        return True  # config-only; lanes decide for themselves at initialize()

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._hermes_home = kwargs.get("hermes_home", "") or os.path.expanduser("~/.hermes")
        agent = kwargs.get("agent_identity", "") or "hermes"
        # SAME namespace convention as the hippocampai lane, so unified recall's
        # HippocampAI lane resolves to this agent's own memories.
        self._user_id = f"agent:{agent}"
        os.environ.setdefault("OPENVIKING_ENDPOINT", _DEFAULT_OV_ENDPOINT)

        from plugins.memory import load_memory_provider
        for lane in _LANES:
            try:
                child = load_memory_provider(lane)
                if child is None:
                    logger.warning("composite: lane %s not found", lane)
                    continue
                if not child.is_available():
                    logger.warning("composite: lane %s not available (config)", lane)
                    _notify("warning", f"Memory lane '{lane}' is disabled",
                            "The composite router could not enable this lane (config/unavailable). Memory still works on the remaining lane(s), which is why nothing appears broken.")
                    continue
                child.initialize(session_id, **kwargs)
                self._children[lane] = child
                for schema in (child.get_tool_schemas() or []):
                    self._tool_owner.setdefault(schema["name"], lane)
            except Exception as e:  # noqa: BLE001
                logger.warning("composite: lane %s failed to initialize: %s", lane, e)
                _notify("warning", f"Memory lane '{lane}' failed to initialize",
                        f"{e}. The other lane(s) keep serving, so memory looks healthy while this one is dark.")
        logger.info("composite: user_id=%s recall=unified-mcp capture-lanes=%s",
                    self._user_id, list(self._children))

    def system_prompt_block(self) -> str:
        return (
            "Persistent memory: ACTIVE (unified multi-backend router). Relevant memories "
            "from past sessions are injected automatically each turn and new facts are "
            "captured automatically."
        )

    # -- recall: single unified-MCP consensus query ----------------------------

    def _unified_recall(self, query: str) -> str:
        """Query the unified memory MCP's REST recall and format for injection."""
        try:
            req = urllib.request.Request(
                _UNIFIED_URL + "/rest/recall",
                data=json.dumps({"query": query[:2000], "k": _RECALL_K,
                                 "user_id": self._user_id}).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=_PREFETCH_DEADLINE_SECS) as r:
                results = json.loads(r.read()).get("results", [])
        except Exception as e:  # noqa: BLE001 — unified MCP down → no injection this turn
            logger.debug("composite: unified recall unavailable (%s)", e)
            return ""
        lines = []
        for m in results:
            text = str(m.get("text") or "").strip()
            if text:
                lines.append(f"- {text}")
        if not lines:
            return ""
        return "Relevant long-term memories:\n" + "\n".join(lines)

    @staticmethod
    def _qkey(q: str) -> str:
        return " ".join((q or "").split())[:2000]

    def _warm(self, query: str) -> None:
        """Start a background consensus recall for THIS turn's message."""
        key = self._qkey(query)
        if not key:
            return
        with self._lock:
            if self._warming == key:
                return          # already in flight for this exact query
            self._warming = key

        def work() -> None:
            try:
                out = self._unified_recall(query)
            except Exception:   # noqa: BLE001 -- warming must never raise
                out = ""
            with self._lock:
                self._prefetched = (key, out)
                self._warming = ""

        threading.Thread(target=work, daemon=True).start()

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return memories for THIS query -- never a leftover from a past turn."""
        key = self._qkey(query)
        deadline = time.time() + _PREFETCH_DEADLINE_SECS
        while True:
            with self._lock:
                warm_key, warm_out = self._prefetched
                in_flight = self._warming == key
                if warm_key == key:
                    self._prefetched = ("", "")
                    return warm_out
            if not in_flight or time.time() >= deadline:
                break
            time.sleep(0.05)
        # No warm for this query (or it timed out): recall synchronously.
        return self._unified_recall(query)

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Deliberately a no-op.

        Hermes calls this at the END of a turn with the message just answered,
        so anything warmed here would be keyed to a question that has already
        been dealt with -- exactly the staleness this class used to serve. The
        real warm happens in on_turn_start(), with the incoming message.
        """
        return

    # -- capture: fan out to the native extraction lanes -----------------------

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", messages: Optional[List[Dict[str, Any]]] = None) -> None:
        # Strip the thinking region BEFORE any lane sees it. Left in, the
        # extractor treats reasoning prose as durable fact and bakes stray
        # </think> tags into stored metadata.
        self._each("sync_turn", user_content, _strip_reasoning(assistant_content),
                   session_id=session_id, messages=messages)

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        # Called with THIS turn's message just before prefetch_all(), so this is
        # the correct place to start the recall.
        self._warm(message)
        self._each("on_turn_start", turn_number, message, **kwargs)

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        self._each("on_session_end", messages)

    def on_session_switch(self, new_session_id: str, **kwargs) -> None:
        self._session_id = new_session_id
        with self._lock:
            self._prefetched = ("", "")
            self._warming = ""
        self._each("on_session_switch", new_session_id, **kwargs)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        outs = self._each("on_pre_compress", messages)
        return "\n".join(v for v in outs.values() if isinstance(v, str) and v.strip())

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        self._each("on_memory_write", action, target, content, metadata)

    def on_delegation(self, task: str, result: str, *, child_session_id: str = "", **kwargs) -> None:
        self._each("on_delegation", task, _strip_reasoning(result),
                   child_session_id=child_session_id, **kwargs)

    def shutdown(self) -> None:
        self._each("shutdown")

    # -- tools: union of the lanes' explicit tools -----------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        schemas: List[Dict[str, Any]] = []
        seen = set()
        for lane, child in self._children.items():
            try:
                for s in child.get_tool_schemas() or []:
                    if s["name"] not in seen:
                        seen.add(s["name"])
                        schemas.append(s)
            except Exception:  # noqa: BLE001
                continue
        return schemas

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        lane = self._tool_owner.get(tool_name)
        child = self._children.get(lane or "")
        if not child:
            return json.dumps({"error": f"no lane owns tool {tool_name}"})
        return child.handle_tool_call(tool_name, args, **kwargs)

    # -- setup / backup --------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "unified_memory_url", "description": "Unified memory MCP REST base URL",
             "default": _UNIFIED_URL, "env_var": "UNIFIED_MEMORY_URL"},
            {"key": "openviking_endpoint", "description": "OpenViking server URL",
             "default": _DEFAULT_OV_ENDPOINT, "env_var": "OPENVIKING_ENDPOINT"},
        ]

    def backup_paths(self) -> List[str]:
        paths: List[str] = []
        for child in self._children.values():
            try:
                paths.extend(child.backup_paths() or [])
            except Exception:  # noqa: BLE001
                continue
        return paths


PROVIDER_CLASS = CompositeProvider
