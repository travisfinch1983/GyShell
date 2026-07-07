#!/usr/bin/env python3
"""acp-bridge — AI-Lab <-> Hermes ACP bridge (runs on CT158, spawned by AI-Lab over SSH).

Drives `hermes -p <profile> acp` as an ACP client (reusing the `acp` lib), and:
  - emits NORMALIZED events as ndjson on stdout (one JSON object per line), and
  - reads prompt commands as ndjson on stdin: {"type":"prompt","text":"..."}.

Per-conversation durability (survives AI-Lab restarts): when spawned with
``--resume <hermes_session_id>`` the bridge calls ACP ``session/load`` instead of
``session/new``. Hermes recreates the agent from its persisted state.db and replays
the prior transcript back to us as session/update notifications, which we forward as
``{"t":"history",...}`` events so the panel can render the restored conversation.
NOTE: this requires each Hermes profile config to define a ``custom`` provider (the
AI-Lab proxy) — restored sessions persist their provider *type* ("custom"), and
without that named entry agent re-creation fails and the load silently no-ops.

The client advertises fs capabilities (read/write text file) so session/load — and
any agent tool that reads a workspace file during replay — is accepted and served.

Normalized stdout events:
  {"t":"ready","session_id":...,"resumed":bool,"models":[...],"current_model":...,"modes":[...]}
  {"t":"history","role":"user|assistant","text":...}   # replayed prior transcript (during load)
  {"t":"history_thought","text":...}                   # replayed reasoning
  {"t":"history_tool","id":...,"title":...,"raw":{...}} # replayed tool call
  {"t":"message","text":...}          # live assistant text chunk
  {"t":"thought","text":...}          # live reasoning chunk
  {"t":"tool_start","id":...,"title":...,"kind":...,"raw":{...}}
  {"t":"tool_progress","id":...,"status":...,"raw":{...}}
  {"t":"commands","commands":[{name,description,input?}]}   # slash-command catalog
  {"t":"usage","raw":{...}}           # token metrics
  {"t":"turn_done","stop_reason":...}
  {"t":"error","where":...,"message":...}
"""
import argparse, asyncio, base64, json, os, sys, traceback

from acp import PROTOCOL_VERSION
from acp.stdio import spawn_agent_process
try:
    from acp.schema import (ClientCapabilities, FileSystemCapabilities, TextContentBlock,
                            RequestPermissionResponse, ReadTextFileResponse)
except Exception:
    ClientCapabilities = FileSystemCapabilities = TextContentBlock = None
    RequestPermissionResponse = ReadTextFileResponse = None


def emit(obj):
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _dump(o):
    try:
        return o.model_dump(mode="json", exclude_none=True) if hasattr(o, "model_dump") else o
    except Exception:
        return str(o)


def _content_text(d):
    c = d.get("content") or {}
    if isinstance(c, dict):
        return c.get("text", "")
    return str(c)


def _strip_view_preamble(text):
    """Remove the page-aware preambles the prompt path prepends (screenshot note +
    [Current view context] {json}) so a DISPLAYED/replayed user turn shows only what the user typed.
    The agent still received the full context at turn time; this is display-only."""
    if not text:
        return text
    import re as _re
    t = _re.sub(r"^\[The user's current screen is captured at[^\]]*\]\s*", "", text, flags=_re.S)
    if t.startswith("[Current view context]"):
        i = t.find("{")
        if i != -1:
            depth = 0
            for j in range(i, len(t)):
                if t[j] == "{":
                    depth += 1
                elif t[j] == "}":
                    depth -= 1
                    if depth == 0:
                        return t[j + 1:].lstrip()
    return t


class BridgeClient:
    # mode == "replay" while a session/load is streaming prior history; "live" otherwise.
    def __init__(self):
        self.mode = "live"

    async def session_update(self, *args, **kwargs):
        upd = kwargs.get("update") or (args[0] if args else None)
        name = type(upd).__name__
        d = _dump(upd) if upd is not None else {}
        replaying = self.mode == "replay"
        # Map ACP session-update variants -> normalized events.
        if name == "AgentMessageChunk":
            emit({"t": "history" if replaying else "message",
                  **({"role": "assistant"} if replaying else {}), "text": _content_text(d)})
        elif name == "UserMessageChunk":
            # Only meaningful during replay (live user turns originate from us).
            emit({"t": "history", "role": "user", "text": _strip_view_preamble(_content_text(d))})
        elif name == "AgentThoughtChunk":
            emit({"t": "history_thought" if replaying else "thought", "text": _content_text(d)})
        elif name in ("ToolCallStart", "ToolCall"):
            emit({"t": "history_tool" if replaying else "tool_start",
                  "id": d.get("tool_call_id") or d.get("id"),
                  "title": d.get("title"), "kind": d.get("kind"), "raw": d})
        elif name in ("ToolCallProgress", "ToolCallUpdate"):
            emit({"t": "tool_progress", "id": d.get("tool_call_id") or d.get("id"),
                  "status": d.get("status"), "raw": d})
        elif name in ("AvailableCommandsUpdate",):
            cmds = d.get("available_commands") or d.get("availableCommands") or []
            emit({"t": "commands", "commands": cmds})
        elif name in ("UsageUpdate", "AgentPlanUpdate", "Plan", "CurrentModeUpdate", "SessionInfoUpdate"):
            emit({"t": name[0].lower() + name[1:], "raw": d})
        else:
            emit({"t": "update", "kind": name, "raw": d})

    async def request_permission(self, *args, **kwargs):
        options = kwargs.get("options")
        if options is None:
            for a in args:
                if isinstance(a, (list, tuple)):
                    options = a; break
        chosen = None
        for o in options or []:
            if "allow" in str(getattr(o, "kind", "") or "").lower():
                chosen = o; break
        if chosen is None and options:
            chosen = options[0]
        opt_id = getattr(chosen, "option_id", getattr(chosen, "id", None))
        emit({"t": "permission_auto_allow", "option_id": opt_id})
        for payload in ({"outcome": {"outcome": "selected", "optionId": opt_id}},
                        {"outcome": {"outcome": "allowed"}}):
            try:
                return RequestPermissionResponse.model_validate(payload)
            except Exception:
                continue
        return RequestPermissionResponse.model_validate({"outcome": {"outcome": "cancelled"}})

    # fs capabilities advertised — serve real reads so session/load and workspace-file
    # tool reads succeed. Writes are accepted (agent-driven) and applied.
    async def read_text_file(self, *a, **k):
        path = k.get("path") or (a[0] if a and isinstance(a[0], str) else None)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                data = f.read()
            line = k.get("line"); limit = k.get("limit")
            if line or limit:
                rows = data.splitlines()
                start = (int(line) - 1) if line else 0
                end = (start + int(limit)) if limit else len(rows)
                data = "\n".join(rows[max(0, start):end])
            return ReadTextFileResponse(content=data) if ReadTextFileResponse else {"content": data}
        except Exception as e:
            emit({"t": "error", "where": "read_text_file", "message": str(e)})
            return ReadTextFileResponse(content="") if ReadTextFileResponse else {"content": ""}

    async def write_text_file(self, *a, **k):
        path = k.get("path"); content = k.get("content")
        try:
            if path is not None:
                d = os.path.dirname(path)
                if d:
                    os.makedirs(d, exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content or "")
        except Exception as e:
            emit({"t": "error", "where": "write_text_file", "message": str(e)})
        return None

    async def create_terminal(self, *a, **k): return None
    async def terminal_output(self, *a, **k): return None
    async def release_terminal(self, *a, **k): return {}
    async def wait_for_terminal_exit(self, *a, **k): return None
    async def kill_terminal(self, *a, **k): return {}
    async def ext_method(self, *a, **k): return {}
    async def ext_notification(self, *a, **k): return None


async def stdin_lines():
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while True:
        line = await reader.readline()
        if not line:
            break
        yield line.decode("utf-8", "replace").strip()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True)
    ap.add_argument("--model")
    ap.add_argument("--provider", default="ailab")
    ap.add_argument("--hermes", default="/usr/local/bin/hermes")
    ap.add_argument("--resume")  # hermes session id to resume via ACP session/load
    args = ap.parse_args()

    # Run the agent from its own profile workspace so Hermes auto-injects that
    # profile's AGENTS.md / .cursorrules (cwd-scoped). Falls back to /root if the
    # profile has no workspace dir (e.g. a not-yet-migrated profile).
    ws = f"/root/.hermes/profiles/{args.profile}/workspace"
    agent_cwd = ws if os.path.isdir(ws) else "/root"

    client = BridgeClient()
    caps = None
    if ClientCapabilities:
        caps = (ClientCapabilities(fs=FileSystemCapabilities(readTextFile=True, writeTextFile=True), terminal=False)
                if FileSystemCapabilities else ClientCapabilities())
    # Never launch hermes with --resume: `session/new` ignores it and the launch flag
    # does not restore conversation context. Resume is done via ACP session/load below.
    hargs = ["-p", args.profile, "acp", "--accept-hooks"]
    async with spawn_agent_process(client, args.hermes, *hargs, cwd=agent_cwd) as (conn, proc):
        try:
            await conn.initialize(protocol_version=PROTOCOL_VERSION, client_capabilities=caps)
            session_id = None
            resumed = False
            models = {}
            modes = {}
            if args.resume:
                # Resume: session/load recreates the agent from state.db AND replays the
                # prior transcript to us (forwarded as {"t":"history",...}). Requires the
                # profile's `custom` provider entry (see module docstring).
                client.mode = "replay"
                try:
                    ld = _dump(await conn.load_session(cwd=agent_cwd, session_id=args.resume))
                    await asyncio.sleep(0.2)  # let trailing replay notifications drain
                    session_id = args.resume
                    resumed = True
                    if isinstance(ld, dict):
                        models = ld.get("models") or {}
                        modes = ld.get("modes") or {}
                except Exception as e:
                    emit({"t": "error", "where": "load_session", "message": str(e)})
                finally:
                    client.mode = "live"
            if session_id is None:
                # New session (or resume failed → start fresh so the tab still works).
                ns = _dump(await conn.new_session(cwd=agent_cwd))
                session_id = ns.get("session_id") or ns.get("sessionId")
                models = (ns.get("models") or {})
                modes = (ns.get("modes") or {})
            emit({"t": "ready", "session_id": session_id, "resumed": resumed,
                  "models": models.get("available_models"), "current_model": models.get("current_model_id"),
                  "modes": modes.get("available_modes")})

            # Run each prompt as a task so the stdin loop stays free to receive a {"type":"cancel"}
            # while the model is inferring. conn.cancel() (ACP session/cancel) makes conn.prompt()
            # resolve with stop_reason "cancelled", so run_prompt always emits a single turn_done.
            async def run_prompt(block):
                stop = None
                try:
                    resp = await conn.prompt(prompt=[block], session_id=session_id)
                    rd = _dump(resp)
                    stop = rd.get("stop_reason") or rd.get("stopReason") or "end_turn"
                except Exception as e:
                    emit({"t": "error", "where": "prompt", "message": str(e)})
                    stop = "error"
                emit({"t": "turn_done", "stop_reason": stop})
            current = None

            async for line in stdin_lines():
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                except Exception:
                    emit({"t": "error", "where": "stdin", "message": "bad json: " + line[:120]}); continue
                if cmd.get("type") == "prompt":
                    text = cmd.get("text", "")
                    # Feature A (page-aware): optional structured view context + screenshot.
                    # The screenshot is saved to a file in the agent's cwd; the agent reads it
                    # with its own read/vision tool (no ACP multimodal dependency).
                    ctx = cmd.get("context")
                    shot = cmd.get("screenshot")
                    preamble = []
                    if shot:
                        try:
                            s = str(shot)
                            if s.startswith("data:"):
                                header, b64 = s.split(",", 1)
                                mime = header[5:].split(";")[0] if ":" in header else "image/png"
                            else:
                                b64, mime = s, "image/png"
                            ext = {"image/jpeg": "jpg", "image/jpg": "jpg",
                                   "image/webp": "webp", "image/png": "png"}.get(mime, "png")
                            shot_path = os.path.join(agent_cwd, ".screen." + ext)
                            with open(shot_path, "wb") as f:
                                f.write(base64.b64decode(b64))
                            preamble.append(
                                f"[The user's current screen is captured at {shot_path} — "
                                f"use your read tool on that path to see exactly what they are looking at.]")
                        except Exception as e:
                            emit({"t": "error", "where": "screenshot", "message": str(e)})
                    if ctx:
                        preamble.append(f"[Current view context]\n{ctx}")
                    full_text = ("\n\n".join(preamble) + "\n\n" + text) if preamble else text
                    block = TextContentBlock(type="text", text=full_text) if TextContentBlock else {"type": "text", "text": full_text}
                    if current and not current.done():
                        emit({"t": "error", "where": "prompt", "message": "busy: a turn is already running"}); continue
                    current = asyncio.create_task(run_prompt(block))
                elif cmd.get("type") == "cancel":
                    # Stop button -> server -> here: abort the in-flight turn via ACP session/cancel.
                    if current and not current.done():
                        try:
                            await conn.cancel(session_id=session_id)
                        except Exception as e:
                            emit({"t": "error", "where": "cancel", "message": str(e)})
                elif cmd.get("type") == "close":
                    if current and not current.done():
                        try:
                            await conn.cancel(session_id=session_id)
                        except Exception:
                            pass
                    break
        except Exception as e:
            emit({"t": "error", "where": "session", "message": str(e), "tb": traceback.format_exc()[:500]})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
