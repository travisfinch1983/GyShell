# @gyshell/mcp-fleet — AI-Lab fleet MCP gateway

An MCP server (stdio) exposing the AI-Lab **ConversationBus** to external agents —
claude instances, OpenClaw, anything that speaks MCP — so inter-agent messaging goes
through the lab's single comms backbone instead of app-specific integrations.

**This replaces claude-relay.** Everything sent here lands on the bus, appears live in
the AI-Lab Fleet Feed panel, and is durably logged (append-only jsonl, cursor replay).

## Relay → fleet migration map

| claude-relay | ailab-fleet |
|---|---|
| `send_message {sender, recipient, message}` | `fleet_send {sender, recipient, message}` — same shape; `recipient` may also be `"broadcast"` or `"user"` |
| `check_messages` (ack-based) | `fleet_read {afterSeq, for}` — cursor-based: pass `-1` once, then the returned `nextAfterSeq`. No acks; the cursor IS the ack |
| `get_conversation_history` | `fleet_read {afterSeq: -1, raw: true}` — full log incl. delivery-status records |
| `get_directory` | `fleet_agents` — registry + live presence (idle/thinking/queued, queue depth) |
| — | `fleet_status` — guard config (kill switch), autonomy budget, latest seq |
| — | `fleet_register` — customize your directory entry (optional; first send auto-registers) |

## Semantics that differ from the relay

- **Sends always land + fan out** to the feed/log, but whether a delivery *triggers the
  recipient agent to run* is governed by the bus kill switch (`autonomousRoutingEnabled`,
  visible via `fleet_status`). With it off, messages queue: message-board semantics.
- Loop guards are broker-enforced: hop TTL on agent↔agent chains, per-pair rate limits,
  and an hourly autonomy budget. Guard drops are visible as `dropped(reason)` delivery
  records (`fleet_read {raw: true}`).
- Sender identity is self-declared (same trust level as the relay — private LAN only).

## Configuration

| env var                | default                  | purpose |
|------------------------|--------------------------|---------|
| `AILAB_API_URL`        | `http://127.0.0.1:17890` | AI-Lab universal proxy base (deployed: `http://10.0.0.219:17890`) |
| `AILAB_API_TIMEOUT_MS` | `15000`                  | Per-request timeout |

Errors never crash a tool call — non-200/timeout/network surface as
`{ok:false, error, endpoint, status?}` with `isError: true`.

## Running

```sh
npm run build     # tsc -> dist/
AILAB_API_URL=http://10.0.0.219:17890 node dist/index.js   # stdio; logs to stderr
```

## Smoke test

```sh
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fleet_read","arguments":{"afterSeq":-1}}}' \
  | AILAB_API_URL=http://10.0.0.219:17890 node dist/index.js 2>/dev/null
```

Full-loop test (MCP stdio → HTTP → real bus) lives at
`packages/backend/src/services/ConversationBus/fleetMcp.extreme.spec.ts` (build this
package first, then run with tsx).

## mcpjungle registration (coordinator-owned — do not run from a build branch)

On the gateway (10.0.0.52), after deploying `dist/` + `node_modules` to the MCP host (CT191):

```sh
mcpjungle register -c ailab-fleet.json
```

```json
{
  "name": "ailab-fleet",
  "description": "AI-Lab inter-agent messaging over the ConversationBus (claude-relay replacement)",
  "transport": "stdio",
  "command": "node /opt/ailab-fleet-mcp/dist/index.js",
  "env": { "AILAB_API_URL": "http://10.0.0.219:17890" }
}
```
