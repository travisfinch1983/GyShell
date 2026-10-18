# Cheat Engine MCP (remote)

Upstream: https://github.com/miscusi-peek/cheatengine-mcp-bridge, pinned at commit `6bd7ce9`
(v12.0.0). One local change: the TCP relay is replaced by
`infra/patches/cheatengine-mcp-bridge/ce_tcp_relay.py` (plain-Python pipe I/O, no pywin32).

```
claude1 (CT181)                    CT110 headscale (10.0.0.67)             legion (Travis's PC, tailnet 100.64.0.2)
Claude Code --stdio--> mcp_cheatengine.py --TCP--> socat :9876 --tailnet--> ce_tcp_relay.py :9876 --pipe--> ce_mcp_bridge.lua (in CE)
/opt/cheatengine-mcp (venv)        ce-mcp-forward.service                  C:\cheatengine-mcp-bridge
                                   (accepts 10.0.0.161 only)
```

- **claude1 side:** `/opt/cheatengine-mcp/` (venv, mcp 1.30 + upstream `MCP_Server/`). Registered in Claude Code
  (user scope) as `cheatengine`: `CE_MCP_TRANSPORT=tcp`, `CE_MCP_HOST=ce-pc.internal`, `CE_MCP_PORT=9876`.
  `ce-pc.internal` is a Technitium A record → 10.0.0.67 (the forwarder). `CE_MCP_ALLOW_SHELL` is NOT set,
  so the run_command/shell_execute tools stay disabled.
- **Forwarder:** CT110 `ce-mcp-forward.service` (copy in `infra/hosts/ct110-headscale/`). claude1 isn't on
  the tailnet, so CT110 (a tailnet node) relays. If legion's tailnet IP changes, edit that unit.
- **Windows side:** run `setup-ce-relay.ps1` (v2, safe to re-run) from an admin PowerShell. Each session:
  attach CE to the game, open the Lua Engine (Ctrl+Alt+L) and Execute
  `dofile([[C:\cheatengine-mcp-bridge\MCP_Server\ce_mcp_bridge.lua]])` (Travis's CE has no File > Execute Script,
  and **File > Open on the .lua attaches CE to the FILE instead of the game**), wait for `MCP Server Listening`,
  then start the "CE MCP relay" desktop shortcut.
- **Diagnose:** `python C:\cheatengine-mcp-bridge\MCP_Server\ce_tcp_relay.py --selftest` pings CE locally, no network.
  No pipe (Errno 2) = the bridge isn't loaded. Verified end to end 2026-10-18: ping 0.175 s over the tailnet.
- Latency: legion reaches CT110 through DERP relay "sea" (~70 ms per round trip), so call-heavy scans are slowish.

## Security
The relay has no authentication, and the Lua bridge serves every command (evaluate_lua,
run_command) to any connecting client. The `CE_MCP_ALLOW_SHELL` gate only exists in the Python MCP
server. Access control is layered: socat on CT110 accepts only 10.0.0.161, and Windows Firewall on
legion allows only 100.64.0.3 (CT110's tailnet IP) and BLOCKS every other address (block rules
override any broad "allow python.exe" rule from Windows' first-run prompt). Only run the relay while
you're using it.
