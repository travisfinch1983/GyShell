# acp-bridge (Hermes ACP bridge)

`acp-bridge.py` is the AI-Lab <-> Hermes ACP bridge. It runs **on the Hermes host
(CT158 / 10.0.0.236)** and is spawned by `HermesAcpBridge.ts` over SSH. This copy is
the version-controlled source of truth.

## Deploy
```
scp acp-bridge.py root@10.0.0.236:/opt/acp-bridge/acp-bridge.py
```
Interpreter: `/usr/local/lib/hermes-agent/venv/bin/python` (has the `acp` lib).
Invoked as: `ssh CT158 <py> /opt/acp-bridge/acp-bridge.py --profile <agentId> [--resume <sessionId>]`

## Session persistence / resume
Resume uses ACP `session/load` (NOT the hermes launch `--resume` flag, which
`session/new` ignores). On load, hermes recreates the agent from its persisted
`state.db` and replays the transcript, which the bridge forwards as `{"t":"history"}`
events for panel display. The client advertises fs capabilities so `session/load`
and workspace-file reads are served.

## REQUIRED per-profile config (CT158 `~/.hermes/profiles/<name>/config.yaml`)
Restored sessions persist their provider **type** (`"custom"`), and hermes resolves
that string as a provider **name** on restore. Without a matching entry it falls back
to a bogus default and agent re-creation fails ("No LLM provider configured") — the
load silently no-ops and every restored prompt returns `refusal` ("session not found").
Define a `custom` provider mirroring the real one (`ailab` = the AI-Lab proxy):

```yaml
providers:
  custom:
    name: AI-Lab Universal Proxy
    api: http://10.0.0.219:17890/api/proxy/llm/v1
    transport: openai_chat
    default_model: Qwen3.6_35B_Uncen-Agent_Mode-2_Slots_256k-Q8-Agent-Instruct
```
`model.provider` stays `ailab` (new sessions unaffected); `custom` only catches the
restore path. Rolled out to all agent profiles on CT158.
