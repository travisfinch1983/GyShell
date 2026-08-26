"""Composite memory ROUTER for Hermes — hippocampai + OpenViking in parallel.

Travis's spec: memory quality is a "does this FEEL right" judgment, so the two
backends must run on the SAME conversations to be comparable. Hermes sees ONE
provider (this); it fans out capture to BOTH lanes and, on recall, logs each
lane's pre-merge results separately (the "memory compare" readout) before
merging them through the lab's existing reranker for the actual injection.

Lanes (loaded via the normal plugin loader, so each keeps its own config):
  1. hippocampai — our user plugin (plugins/hippocampai/), HippocampAI REST.
  2. openviking  — Hermes' BUNDLED OpenViking provider, pointed at the lab's
     instance via OPENVIKING_ENDPOINT (default http://10.0.0.156:1933).

Compare log: $HERMES_HOME/memory-compare.jsonl — one line per recalled turn:
  {ts, session_id, query, lanes: {hippocampai: "...", openviking: "..."},
   injected: "..."}  → tail it while chatting to eyeball lane quality.

Merge: bullet lines from both lanes are reranked against the query by the
proxlab cross-encoder (POST /api/proxy/rerank/v2/rerank {query, documents} →
results[{index, relevance_score}]); top-K become the injected block. If the
reranker is down or slow, fall back to concatenating both lanes.

Hot-path safety: each lane's prefetch runs in its own thread with a joint
deadline — a slow lane contributes nothing that turn instead of stalling it.
All write-side hooks fan out with per-lane exception isolation: one broken
backend never takes the other down.

Install (per agent profile):
  $HERMES_HOME/plugins/composite/__init__.py    (this file)
  $HERMES_HOME/plugins/hippocampai/__init__.py  (lane 1)
  config.yaml → memory: provider: composite
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_LANES = ("hippocampai", "openviking")
_DEFAULT_OV_ENDPOINT = os.environ.get("OPENVIKING_ENDPOINT", "http://10.0.0.156:1933")
_RERANK_URL = os.environ.get(
    "MEMORY_RERANK_URL", "http://10.0.0.219:17890/api/proxy/rerank/v2/rerank")
_PREFETCH_DEADLINE_SECS = float(os.environ.get("MEMORY_PREFETCH_DEADLINE", "4.0") or 4.0)
_MERGE_TOP_K = int(os.environ.get("MEMORY_MERGE_TOP_K", "8") or 8)


def _bullets(block: str) -> List[str]:
    """Split a lane's formatted recall block into candidate memory lines."""
    out = []
    for line in (block or "").splitlines():
        line = line.strip()
        if line.startswith("- "):
            out.append(line[2:].strip())
        elif line and not line.endswith(":"):
            out.append(line)
    return [l for l in out if l]


class CompositeProvider(MemoryProvider):
    """One provider to Hermes; hippocampai + OpenViking underneath."""

    def __init__(self) -> None:
        self._children: Dict[str, MemoryProvider] = {}
        self._hermes_home = ""
        self._session_id = ""
        self._compare_path = ""
        self._tool_owner: Dict[str, str] = {}

    @property
    def name(self) -> str:
        return "composite"

    @property
    def description(self) -> str:
        return "AI-Lab memory router — hippocampai + OpenViking in parallel with per-lane compare logging"

    # -- fan-out helpers -------------------------------------------------------

    def _each(self, method: str, *args, **kwargs) -> Dict[str, Any]:
        """Call method on every lane, isolating failures per lane."""
        out: Dict[str, Any] = {}
        for lane, child in self._children.items():
            try:
                out[lane] = getattr(child, method)(*args, **kwargs)
            except Exception as e:  # noqa: BLE001 — one lane must not sink the other
                logger.warning("composite: lane %s %s failed: %s", lane, method, e)
        return out

    # -- core lifecycle ----------------------------------------------------------

    def is_available(self) -> bool:
        return True  # config-only; lanes decide for themselves at initialize()

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._hermes_home = kwargs.get("hermes_home", "") or os.path.expanduser("~/.hermes")
        self._compare_path = os.path.join(self._hermes_home, "memory-compare.jsonl")
        # the bundled openviking lane activates off this env var
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
                    continue
                child.initialize(session_id, **kwargs)
                self._children[lane] = child
                for schema in (child.get_tool_schemas() or []):
                    self._tool_owner.setdefault(schema["name"], lane)
            except Exception as e:  # noqa: BLE001
                logger.warning("composite: lane %s failed to initialize: %s", lane, e)
        logger.info("composite: active lanes: %s", list(self._children))

    def system_prompt_block(self) -> str:
        return (
            "Persistent memory: ACTIVE (dual-backend router). Relevant memories from "
            "past sessions are injected automatically each turn and new facts are "
            "captured automatically."
        )

    # -- recall: dual-lane + compare log + rerank merge ----------------------------

    def _rerank(self, query: str, docs: List[str]) -> List[str]:
        if len(docs) <= 1:
            return docs
        try:
            req = urllib.request.Request(
                _RERANK_URL,
                data=json.dumps({"query": query, "documents": docs}).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=_PREFETCH_DEADLINE_SECS) as r:
                results = json.loads(r.read()).get("results", [])
            ranked = sorted(results, key=lambda x: x.get("relevance_score", 0), reverse=True)
            return [docs[x["index"]] for x in ranked if 0 <= x.get("index", -1) < len(docs)]
        except Exception as e:  # noqa: BLE001 — reranker down → keep lane order
            logger.debug("composite: rerank unavailable (%s) — concatenating lanes", e)
            return docs

    def _log_compare(self, query: str, lanes: Dict[str, str], injected: str) -> None:
        try:
            with open(self._compare_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "session_id": self._session_id,
                    "query": query[:500],
                    "lanes": {k: v[:4000] for k, v in lanes.items()},
                    "injected": injected[:4000],
                }, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001 — the log is an observability nicety
            pass

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        lanes: Dict[str, str] = {}
        threads = []
        for lane, child in self._children.items():
            def work(l=lane, c=child) -> None:
                try:
                    lanes[l] = c.prefetch(query, session_id=session_id) or ""
                except Exception as e:  # noqa: BLE001
                    logger.debug("composite: lane %s prefetch failed: %s", l, e)
                    lanes[l] = ""
            t = threading.Thread(target=work, daemon=True)
            t.start()
            threads.append(t)
        deadline = time.time() + _PREFETCH_DEADLINE_SECS
        for t in threads:
            t.join(max(0.05, deadline - time.time()))

        nonempty = {k: v for k, v in lanes.items() if v.strip()}
        if not nonempty:
            return ""
        # dedup candidate lines across lanes, keep provenance-free text
        seen = set()
        docs: List[str] = []
        for block in nonempty.values():
            for line in _bullets(block):
                key = line.lower()
                if key not in seen:
                    seen.add(key)
                    docs.append(line)
        merged = self._rerank(query, docs)[:_MERGE_TOP_K]
        injected = ("Relevant long-term memories:\n" + "\n".join(f"- {d}" for d in merged)) if merged else ""
        self._log_compare(query, lanes, injected)
        return injected

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        self._each("queue_prefetch", query, session_id=session_id)

    # -- capture: fan out everything ------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", messages: Optional[List[Dict[str, Any]]] = None) -> None:
        self._each("sync_turn", user_content, assistant_content,
                   session_id=session_id, messages=messages)

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        self._each("on_turn_start", turn_number, message, **kwargs)

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        self._each("on_session_end", messages)

    def on_session_switch(self, new_session_id: str, **kwargs) -> None:
        self._session_id = new_session_id
        self._each("on_session_switch", new_session_id, **kwargs)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        outs = self._each("on_pre_compress", messages)
        return "\n".join(v for v in outs.values() if isinstance(v, str) and v.strip())

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        self._each("on_memory_write", action, target, content, metadata)

    def on_delegation(self, task: str, result: str, *, child_session_id: str = "", **kwargs) -> None:
        self._each("on_delegation", task, result, child_session_id=child_session_id, **kwargs)

    def shutdown(self) -> None:
        self._each("shutdown")

    # -- tools: union of the lanes' explicit tools ------------------------------------

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

    # -- setup / backup ------------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "openviking_endpoint", "description": "OpenViking server URL",
             "default": _DEFAULT_OV_ENDPOINT, "env_var": "OPENVIKING_ENDPOINT"},
            {"key": "rerank_url", "description": "Cross-encoder rerank endpoint",
             "default": _RERANK_URL, "env_var": "MEMORY_RERANK_URL"},
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
