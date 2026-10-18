# Cheat Engine MCP (remote)

Upstream: https://github.com/miscusi-peek/cheatengine-mcp-bridge, pinned at commit `6bd7ce9`
(v12.0.0, unmodified).

```
claude1 (CT181)                                    Windows PC running Cheat Engine
Claude Code --stdio--> mcp_cheatengine.py --TCP:9876--> ce_tcp_relay.py --named pipe--> ce_mcp_bridge.lua (in CE)
/opt/cheatengine-mcp (venv, mcp 1.30)              C:\cheatengine-mcp-bridge
```

- **claude1 side:** `/opt/cheatengine-mcp/` (venv + upstream `MCP_Server/`). Registered in Claude Code
  (user scope) as `cheatengine` with `CE_MCP_TRANSPORT=tcp`, `CE_MCP_HOST=<PC IP>`, `CE_MCP_PORT=9876`.
  `CE_MCP_ALLOW_SHELL` is NOT set, so the run_command/shell_execute tools stay disabled.
- **Windows side:** run `setup-ce-relay.ps1` once from an admin PowerShell. Each session: load
  `ce_mcp_bridge.lua` in CE (File > Execute Script), then start the "CE MCP relay" desktop shortcut.

## Security
The relay has no authentication, and the Lua bridge serves every command (evaluate_lua,
run_command) to any connecting client. The `CE_MCP_ALLOW_SHELL` gate only exists in the Python MCP
server. So access is enforced by Windows Firewall: an allow rule for 10.0.0.161 only, plus a BLOCK
rule for every other address (block rules override any broad "allow python.exe" rule Windows creates
from its first-run prompt). Only run the relay while you're using it.
