# MCP servers (version-controlled copies)

The RUNNING copy of each server lives at `/opt/mcp-<name>/server.mjs` — the **spawn path**
MCPJungle launches. That path is NOT this repo. Editing the repo copy changes nothing until
it is copied over and the server re-registered.

Deploy:
    cp infra/mcp-servers/ailab-svg.server.mjs /opt/mcp-ailab-svg/server.mjs
    # then deregister/re-register with MCPJungle so the cached TOOL LIST is refreshed —
    # a plain restart keeps serving the old list (reference_mcpjungle_tool_deploy).

These copies exist so a fresh checkout is not missing the servers entirely, which is the same
class of trap as an untracked acp-bridge.py or a hand-vendored draw.io.
