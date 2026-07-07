"""acp-tool-override — per-agent native-tool on/off for the AI-Lab ACP chat agent.

WHY: the ACP runtime hardcodes ``enabled_toolsets=["hermes-acp"]`` at agent
creation and never honors ``agent.disabled_toolsets``, so native tools (browser,
etc.) can't be toggled through normal config. This plugin redefines the
``hermes-acp`` toolset at load — ``create_custom_toolset`` overwrites
``TOOLSETS["hermes-acp"]`` — dropping the tools the operator has switched off.

DESIRED STATE is read fresh on every load from ``state.json`` beside this file
(written by the AI-Lab settings UI). Because the plugin re-applies at every ACP
process/agent creation, the UI toggle is the single source of truth, it survives
``hermes update`` (user-plugin dir), and there is nothing to reconcile — no
watchdog. ``vision_analyze`` is never in the browser set, so AI-Lab's view_screen
capture keeps working.

state.json:
  {"disabled_toolsets": ["browser", ...], "disabled_tools": ["exact_tool", ...]}
Missing / unreadable state.json -> DEFAULT below (browser off).
"""
from __future__ import annotations
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Default when no state.json is present: the 12 browser-AUTOMATION tools off for
# every chat agent. Scoped by exact name (NOT the "browser" toolset) on purpose:
# Hermes bundles web_search into its "browser" toolset, and we want web search to
# stay available — only the headless-browser tools go.
_BROWSER_AUTOMATION = [
    "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
    "browser_scroll", "browser_back", "browser_press", "browser_get_images",
    "browser_vision", "browser_console", "browser_cdp", "browser_dialog",
]
_DEFAULT = {"disabled_toolsets": [], "disabled_tools": list(_BROWSER_AUTOMATION)}
_STATE = Path(__file__).resolve().parent / "state.json"
_orig_tools = None  # pristine hermes-acp tool list, captured once per process


def _load_state() -> dict:
    try:
        if _STATE.exists():
            d = json.loads(_STATE.read_text())
            return {
                "disabled_toolsets": [str(x) for x in (d.get("disabled_toolsets") or [])],
                "disabled_tools": [str(x) for x in (d.get("disabled_tools") or [])],
            }
    except Exception:
        logger.warning("acp-tool-override: unreadable state.json — using default", exc_info=True)
    return {"disabled_toolsets": list(_DEFAULT["disabled_toolsets"]),
            "disabled_tools": list(_DEFAULT["disabled_tools"])}


def _apply() -> None:
    global _orig_tools
    try:
        from toolsets import TOOLSETS, create_custom_toolset, resolve_toolset
    except Exception:
        logger.warning("acp-tool-override: toolsets module unavailable", exc_info=True)
        return
    cur = TOOLSETS.get("hermes-acp")
    if not cur:
        logger.warning("acp-tool-override: hermes-acp toolset missing")
        return
    if _orig_tools is None:
        _orig_tools = list(cur.get("tools", []))  # pristine (browser-inclusive) superset

    st = _load_state()
    remove = set(st["disabled_tools"])
    for ts in st["disabled_toolsets"]:
        try:
            remove |= set(resolve_toolset(ts) or [])
        except Exception:
            logger.debug("acp-tool-override: could not resolve toolset %s", ts, exc_info=True)

    # Always rebuild from the pristine superset so re-enabling a tool restores it.
    kept = [t for t in _orig_tools if t not in remove]
    base_desc = str(cur.get("description", "")).split(" [acp-tool-override")[0]
    n_removed = len(_orig_tools) - len(kept)
    create_custom_toolset(
        "hermes-acp",
        base_desc + (f" [acp-tool-override: -{n_removed} tool(s)]" if n_removed else ""),
        tools=kept,
        includes=list(cur.get("includes", [])),
    )
    logger.info("acp-tool-override: hermes-acp -> %d tools (removed %d): %s",
                len(kept), n_removed, sorted(t for t in _orig_tools if t in remove))


# Apply at import (plugin load) and again on register(), before any agent is built.
_apply()


def register(ctx) -> None:
    _apply()
