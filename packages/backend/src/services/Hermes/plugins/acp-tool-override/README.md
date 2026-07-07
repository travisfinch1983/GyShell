# acp-tool-override (Hermes plugin)

Per-agent native-tool on/off for the AI-Lab **ACP chat agent**.

## Why it exists
The ACP runtime hardcodes `enabled_toolsets=["hermes-acp"]` at agent creation
(`acp_adapter/session.py::_make_agent`) and never honors `agent.disabled_toolsets`,
so native tools (browser automation, etc.) can't be turned off through normal
Hermes config. This plugin uses Hermes's own plugin API — `create_custom_toolset`
**overwrites** `TOOLSETS["hermes-acp"]` — to redefine that toolset at load, dropping
the tools the operator switched off. Not a source patch; survives `hermes update`
(user-plugin dir); re-applies on every ACP agent creation, so there's nothing to
reconcile (no watchdog).

## Deploy (per Hermes profile, on CT158 / 10.0.0.236)
```
~/.hermes/profiles/<agent>/plugins/acp-tool-override/
  ├── __init__.py      (this plugin — register(ctx) + import-time _apply())
  ├── plugin.yaml
  └── state.json       (desired state — written by the AI-Lab settings UI)
```
Enable in that profile's `config.yaml`:
```yaml
plugins:
  enabled:
  - acp-tool-override
```
Rolled out to all 8 agent profiles (anvil, cinder, custodian, loom, main,
professor, reporter, turing).

## state.json contract (what the UI writes)
```json
{ "disabled_toolsets": ["browser"], "disabled_tools": ["browser_vision", "..."] }
```
- `disabled_tools` — exact tool names to strip from hermes-acp.
- `disabled_toolsets` — Hermes toolset names; each is resolved to its tools and
  stripped. NOTE: Hermes's `browser` toolset bundles `web_search`, so the default
  uses `disabled_tools` (the 12 browser-automation names) to keep web search.
- Missing/unreadable → DEFAULT: the 12 browser-automation tools off, web_search kept.
- Re-enable a tool by removing it from the lists — the plugin rebuilds from the
  pristine superset each load.

Changes take effect on the **next ACP session spawn** for that agent (each chat
conversation spawns a fresh `hermes acp` process, which re-reads state.json).
