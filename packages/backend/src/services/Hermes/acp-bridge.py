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
  {"t":"fatal","reason":"stream_broken","recoverable":true,"message":...}  # read loop died; restart chat
"""
import argparse, asyncio, base64, json, os, sys, traceback

from acp import PROTOCOL_VERSION
from acp.stdio import spawn_agent_process
try:
    from acp.schema import (ClientCapabilities, FileSystemCapabilities, TextContentBlock,
                            ImageContentBlock, RequestPermissionResponse, ReadTextFileResponse)
except Exception:
    ClientCapabilities = FileSystemCapabilities = TextContentBlock = None
    ImageContentBlock = RequestPermissionResponse = ReadTextFileResponse = None


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


def _parse_image(src):
    """(data-URL | bare-base64) -> (base64_str, mime). Defaults to image/png."""
    s = str(src)
    if s.startswith("data:"):
        header, b64 = s.split(",", 1)
        mime = header[5:].split(";")[0] if ":" in header else "image/png"
        return b64, (mime or "image/png")
    return s, "image/png"


def _image_block(b64, mime):
    """Build a NATIVE ACP ImageContentBlock (base64 data + mimeType). Hermes' acp_adapter
    (server.py::_image_block_to_openai_part) maps this to an OpenAI-style image_url part; its
    gateway then routes native (vision model sees the pixels) vs describe (text-only model) per
    `agent.image_input_mode`/`model.supports_vision`. Falls back to a plain dict if the schema
    class isn't importable."""
    if ImageContentBlock is not None:
        try:
            return ImageContentBlock(type="image", data=b64, mime_type=mime)
        except Exception:
            pass
    return {"type": "image", "data": b64, "mimeType": mime}


def _strip_view_preamble(text):
    """Remove the page-aware preambles the prompt path prepends (screenshot note +
    [Current view context] {json}) so a DISPLAYED/replayed user turn shows only what the user typed.
    The agent still received the full context at turn time; this is display-only."""
    if not text:
        return text
    import re as _re
    t = _re.sub(r"^\[The user's current screen is (?:captured at|attached)[^\]]*\]\s*", "", text, flags=_re.S)
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


# The exact replies Hermes's _cmd_steer can produce (acp_adapter/server.py ~L1956).
# These arrive as normal agent messages, so they are matched by content — the ACP update
# carries nothing to distinguish them. Matching is scoped to a window where a steer is
# actually in flight, so ordinary agent text starting with these words is never eaten.
_STEER_ACK_MARKERS = (
    "\u23e9 Steer queued for the active turn:",
    "No active turn \u2014 queued for the next turn.",
    "\u26a0\ufe0f Steer failed:",
    "Usage: /steer",
)


def _is_steer_ack(text):
    t = (text or "").strip()
    return any(t.startswith(m) for m in _STEER_ACK_MARKERS)


class BridgeClient:
    # mode == "replay" while a session/load is streaming prior history; "live" otherwise.
    def __init__(self):
        self.mode = "live"
        # >0 while a /steer prompt is outstanding; gates ack interception (trap 2).
        self.steer_pending = 0
        # Set when an ack is intercepted — distinguishes a true steer from Hermes
        # rewriting /steer into a real turn on an idle session (trap 3).
        self.steer_ack_seen = False

    async def session_update(self, *args, **kwargs):
        upd = kwargs.get("update") or (args[0] if args else None)
        name = type(upd).__name__
        d = _dump(upd) if upd is not None else {}
        replaying = self.mode == "replay"
        # Map ACP session-update variants -> normalized events.
        if name == "AgentMessageChunk":
            _txt = _content_text(d)
            # Trap 2: divert a steer ack so it is not appended into the live assistant bubble.
            if self.steer_pending and not replaying and _is_steer_ack(_txt):
                self.steer_ack_seen = True
                emit({"t": "steer_ack", "text": _txt})
                return
            emit({"t": "history" if replaying else "message",
                  **({"role": "assistant"} if replaying else {}), "text": _txt})
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
    # The AI-Lab backend spawns ONE process per conversation, so the conversation id is a
    # property of this process. It arrives via the spawn env rather than a flag so that
    # nothing has to thread it through every call site. Empty => not supplied (older backend).
    conv_id = os.environ.get("AILAB_CONVERSATION_ID") or ""
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
    async with spawn_agent_process(client, args.hermes, *hargs, cwd=agent_cwd, transport_kwargs={"limit": 64 * 1024 * 1024, "stderr": None}) as (conn, proc):
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
                  "conversation_id": conv_id or None,
                  "models": models.get("available_models"), "current_model": models.get("current_model_id"),
                  "modes": modes.get("available_modes")})

            # Run each prompt as a task so the stdin loop stays free to receive a {"type":"cancel"}
            # while the model is inferring. conn.cancel() (ACP session/cancel) makes conn.prompt()
            # resolve with stop_reason "cancelled", so run_prompt always emits a single turn_done.
            # A transport-level failure (e.g. an ACP event larger than the stdio read buffer)
            # kills the connection's read loop and ORPHANS the Hermes subprocess — it keeps
            # inferring into a dead pipe while the UI silently freezes. Detect those specifically:
            # emit a clear recoverable-terminal signal, kill the orphaned Hermes, and exit so the
            # backend sees the dead session and the UI can reconnect/respawn a clean one.
            _FATAL_STREAM = (asyncio.LimitOverrunError, asyncio.IncompleteReadError,
                             ConnectionError, EOFError, BrokenPipeError)

            def _is_fatal_stream(e):
                if isinstance(e, _FATAL_STREAM):
                    return True
                m = str(e).lower()
                return ("longer than limit" in m or "separator is found" in m
                        or "incomplete read" in m or "connection lost" in m or "connection closed" in m)

            async def run_prompt(blocks):
                stop, fatal = None, False
                try:
                    resp = await conn.prompt(prompt=blocks, session_id=session_id)
                    rd = _dump(resp)
                    stop = rd.get("stop_reason") or rd.get("stopReason") or "end_turn"
                except Exception as e:
                    if _is_fatal_stream(e):
                        emit({"t": "fatal", "reason": "stream_broken", "recoverable": True,
                              "message": ("ACP stream broke (" + type(e).__name__ + "): " + str(e)[:200]
                                          + " — restart this chat to reconnect.")})
                        stop, fatal = "error", True
                    else:
                        emit({"t": "error", "where": "prompt", "message": str(e)})
                        stop = "error"
                emit({"t": "turn_done", "stop_reason": stop})
                if fatal:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    sys.stdout.flush()
                    os._exit(3)
            current = None
            # Tell the agent its own conversation id ONCE per process, on the first turn.
            # Agents otherwise have no idea which conversation they are in and pass their own
            # profile name to tools that scope state per conversation, forcing every caller to
            # guess (last-active wins => a coin flip with two live conversations on one profile).
            # Injected on the first turn rather than at session create because it has to land in
            # the model's context, and a resumed session starts a NEW process whose replayed
            # history predates this statement.
            conv_injected = False

            async for line in stdin_lines():
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                except Exception:
                    emit({"t": "error", "where": "stdin", "message": "bad json: " + line[:120]}); continue
                if cmd.get("type") == "prompt":
                    text = cmd.get("text", "")
                    # Feature A (page-aware): optional structured view context.
                    ctx = cmd.get("context")
                    # Images ride along as NATIVE ACP ImageContentBlocks (base64 data + mimeType):
                    #   - `screenshot`: the single page-aware screen capture (Feature A), and/or
                    #   - `images`: an explicit list (chat attachments, workflow frames).
                    # Hermes converts each to an OpenAI image_url part and routes native (vision
                    # model sees pixels) vs describe (text-only model) per model capability — no
                    # save-to-file / read-tool round-trip, no lossy separate-model description for
                    # a vision-capable agent.
                    raw_images = []
                    if cmd.get("screenshot"):
                        raw_images.append(("screen", cmd.get("screenshot")))
                    for im in (cmd.get("images") or []):
                        raw_images.append(("image", im))
                    image_blocks, saw_screen = [], False
                    for kind, src in raw_images:
                        try:
                            b64, mime = _parse_image(src)
                            image_blocks.append(_image_block(b64, mime))
                            if kind == "screen":
                                saw_screen = True
                        except Exception as e:
                            emit({"t": "error", "where": "image", "message": str(e)})
                    preamble = []
                    if saw_screen:
                        preamble.append("[The user's current screen is attached as an image — "
                                        "look at it to see exactly what they are viewing.]")
                    if ctx:
                        preamble.append(f"[Current view context]\n{ctx}")
                    if conv_id and not conv_injected:
                        preamble.insert(0, f"[Session context] conversationId: {conv_id}\n"
                                           "This identifies THIS conversation. When a tool scopes state "
                                           "per conversation, pass this value verbatim — never your "
                                           "profile/agent name.")
                        conv_injected = True
                    full_text = ("\n\n".join(preamble) + "\n\n" + text) if preamble else text
                    text_block = TextContentBlock(type="text", text=full_text) if TextContentBlock else {"type": "text", "text": full_text}
                    blocks = [text_block] + image_blocks
                    if current and not current.done():
                        emit({"t": "error", "where": "prompt", "message": "busy: a turn is already running"}); continue
                    current = asyncio.create_task(run_prompt(blocks))
                elif cmd.get("type") == "cancel":
                    # Stop button -> server -> here: abort the in-flight turn via ACP session/cancel.
                    if current and not current.done():
                        try:
                            await conn.cancel(session_id=session_id)
                        except Exception as e:
                            emit({"t": "error", "where": "cancel", "message": str(e)})
                elif cmd.get("type") == "steer":
                    # Inject guidance into the RUNNING turn rather than waiting for idle.
                    # Deliberately NOT run_prompt: that emits turn_done, and a steer resolves
                    # immediately with end_turn — which would end the real turn in the UI while
                    # the agent is still working (trap 1). Also bypasses the "busy: a turn is
                    # already running" guard on purpose: landing mid-turn is the entire point.
                    stext = (cmd.get("text") or "").strip()
                    if not stext:
                        emit({"t": "error", "where": "steer", "message": "empty steer text"})
                        continue

                    async def run_steer(t=stext):
                        client.steer_pending += 1
                        client.steer_ack_seen = False
                        body = "/steer " + t
                        blk = (TextContentBlock(type="text", text=body) if TextContentBlock
                               else {"type": "text", "text": body})
                        stop = None
                        try:
                            resp = await conn.prompt(prompt=[blk], session_id=session_id)
                            rd = _dump(resp)
                            stop = rd.get("stop_reason") or rd.get("stopReason") or "end_turn"
                        except Exception as e:
                            emit({"t": "error", "where": "steer", "message": str(e)})
                            print("[bridge] steer FAILED: " + str(e), file=sys.stderr, flush=True)
                            client.steer_pending = max(0, client.steer_pending - 1)
                            return
                        acked = client.steer_ack_seen
                        client.steer_pending = max(0, client.steer_pending - 1)
                        if not acked:
                            # Trap 3: no ack means Hermes did NOT treat this as a steer. The
                            # session was idle, so it rewrote /steer into a normal prompt and ran
                            # a REAL turn. Forward that turn_done or the composer never unlocks.
                            print("[bridge] steer landed on an IDLE session -> Hermes ran it as a "
                                  "full turn; forwarding turn_done (stop=" + str(stop) + ")",
                                  file=sys.stderr, flush=True)
                            emit({"t": "turn_done", "stop_reason": stop})
                    asyncio.create_task(run_steer())
                elif cmd.get("type") == "set_model":
                    # Swap the model for THIS conversation's live session (ACP session/set_model).
                    # Hermes re-creates the session agent with the new model and persists it, so the
                    # switch survives reconnect. model_id is any AI-Lab proxy catalog id (routes via
                    # the ailab provider). Tries the typed client method, falls back to a raw request.
                    mid = cmd.get("model_id")
                    if not mid:
                        emit({"t": "error", "where": "set_model", "message": "model_id required"})
                    else:
                        try:
                            if hasattr(conn, "set_session_model"):
                                await conn.set_session_model(session_id=session_id, model_id=mid)
                            elif hasattr(conn, "session_set_model"):
                                await conn.session_set_model(session_id=session_id, model_id=mid)
                            else:
                                await conn.send_request("session/set_model", {"sessionId": session_id, "modelId": mid})
                            emit({"t": "model_set", "model_id": mid})
                        except Exception as e:
                            emit({"t": "error", "where": "set_model", "message": str(e)})
                elif cmd.get("type") == "close":
                    if current and not current.done():
                        try:
                            await conn.cancel(session_id=session_id)
                        except Exception:
                            pass
                    break
                else:
                    # An unrecognized command used to fall straight through this if/elif chain
                    # and vanish. That is how a NEW backend talking to an OLD deployed bridge
                    # fails: the write succeeds, the caller sees success, and nothing happens.
                    # Cost me two full test cycles chasing a phantom. Say it loudly instead.
                    _t = cmd.get("type")
                    emit({"t": "error", "where": "stdin",
                          "message": "unknown command type " + repr(_t)
                                     + " — this bridge is older than the backend that sent it"})
                    print("[bridge] UNKNOWN stdin command " + repr(_t)
                          + " — ignoring. If this is a real command, /opt/acp-bridge/acp-bridge.py "
                          + "is STALE relative to the repo copy.", file=sys.stderr, flush=True)
        except Exception as e:
            emit({"t": "error", "where": "session", "message": str(e), "tb": traceback.format_exc()[:500]})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
