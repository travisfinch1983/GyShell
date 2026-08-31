#!/usr/bin/env python3
"""
Fleet Forwarder — one process that delivers AI-Lab fleet-bus messages to
every local Claude Code instance's dtach session on this container.

Replaces the per-instance relay-injectors + the standalone claude-relay server:
it polls AI-Lab's ConversationBus feed (the single source of truth) and injects
each envelope addressed to a local instance straight into that instance's dtach
pty — the "relay_outbound_unwired" delivery path the bus is missing.

Config: /opt/fleet-forwarder/config.json
  { "feed_base": "http://10.0.0.219:17890/api/fleet",
    "poll_interval": 5, "inject_cooldown": 8,
    "instances": { "<agentId>": "/tmp/<sock>", ... } }

Cursor persisted at /var/lib/fleet-forwarder/cursor so a restart never
re-injects. FIRST run (no cursor) starts at the bus's latestSeq — it does
NOT replay history (no backlog dump into every session).

Runs as root so it can write to sockets owned by the per-instance users.
"""
import json, os, sys, time, signal, subprocess, urllib.request

CONFIG_PATH = os.environ.get("FF_CONFIG", "/opt/fleet-forwarder/config.json")
CURSOR_PATH = "/var/lib/fleet-forwarder/cursor"
DISABLE_FLAG = "/etc/fleet-forwarder/disabled"

SENDER_NAMES = {
    "claude1": "Claude1", "claude2": "Claude2", "claude-web": "Claude-Web",
    "claude-dhb": "Claude-DHB", "fable-builder": "Fable", "zack": "Zack's Claude",
    "openclaw-claude": "OpenClaw-Claude", "cinder": "Cinder", "custodian": "Custodian",
}
running = True


def log(m): print(f"[fleet-forwarder] {m}", flush=True)


def cleanup(*_):
    global running
    running = False
    sys.exit(0)


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def http_get(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def http_post(url, body, timeout=8):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# The cursor advances BEFORE injection (so a wedged session can't replay a
# message forever). That means anything we are holding — a failed delivery, or
# a message deferred by the quiet gate — is ALREADY past the cursor and would
# be lost outright if this process restarted. The quiet gate made that routine
# rather than rare: every message that arrives while Travis is typing sits in
# the queue for as long as he keeps typing. So the queue has to survive us.
QUEUE_PATH = "/var/lib/fleet-forwarder/queue.json"


def read_queue():
    try:
        with open(QUEUE_PATH) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        log(f"queue read failed ({e}) — starting empty; held messages may be lost")
        return {}


def write_queue(retry):
    """Persist only non-empty backlogs. Atomic, same pattern as the cursor."""
    try:
        data = {a: v for a, v in retry.items() if v}
        os.makedirs(os.path.dirname(QUEUE_PATH), exist_ok=True)
        tmp = QUEUE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, QUEUE_PATH)
    except Exception as e:
        log(f"QUEUE PERSIST FAILED: {e} — {sum(len(v) for v in retry.values())} "
            f"held msg(s) would be lost on restart")


def read_cursor():
    try:
        with open(CURSOR_PATH) as f:
            return int(f.read().strip())
    except Exception:
        return None


def write_cursor(seq):
    os.makedirs(os.path.dirname(CURSOR_PATH), exist_ok=True)
    tmp = CURSOR_PATH + ".tmp"
    with open(tmp, "w") as f:
        f.write(str(seq))
    os.replace(tmp, CURSOR_PATH)


def socket_ok(path):
    try:
        import stat
        return stat.S_ISSOCK(os.stat(path).st_mode)
    except Exception:
        return False


# ─── Quiet-period gate ───────────────────────────────────────────────────────
# Injection simulates typing. If it lands while Travis is mid-sentence, his text
# and ours merge and the CR submits the mangled result — his message truncated,
# ours mixed in. Fix: only inject into a session that has been QUIET for a while.
#
# The activity signal is the pty's MTIME. Verified on CT180 2026-07-28:
#   - atime is USELESS here: /dev/pts is mounted `relatime`, which suppresses
#     atime updates, and pushing input via `dtach -p` never moved either
#     timestamp (measured: 33s -> 37 -> 38 -> 42 -> 43, straight through two
#     keystroke pushes). Do not retry the atime approach.
#   - mtime DOES track activity, because the TUI writes to the pty: it echoes
#     and re-renders the input line on every keystroke, and streams model
#     output. So "mtime is fresh" == "this terminal is in use", which covers
#     both the human typing AND an agent mid-turn. Both are bad times to inject.
# Measured spread at implementation time: claude1 1s (in use) vs fable-builder
# 849s, claude2 124768s, claude-amp 70479s — a clean discriminator.
#
# A session that never goes quiet must not starve the queue forever, so after
# MAX_DEFER_SECONDS we inject anyway and say so.
QUIET_SECONDS = 15          # required idle before injecting; overridable in config.json
MAX_DEFER_SECONDS = 600     # give up deferring after this and deliver regardless

_pty_cache = {}


def _descendants(pid):
    out, stack = [], [pid]
    while stack:
        p = stack.pop()
        try:
            kids = subprocess.run(["pgrep", "-P", str(p)], capture_output=True,
                                  text=True, timeout=5).stdout.split()
        except Exception:
            kids = []
        for k in kids:
            out.append(int(k)); stack.append(int(k))
    return out


def pty_for(sock):
    """Resolve the pty behind a dtach socket. Cached; re-resolved if it dies."""
    cached = _pty_cache.get(sock)
    if cached and os.path.exists(cached):
        return cached
    try:
        found = subprocess.run(["pgrep", "-f", f"dtach -N {sock}"],
                               capture_output=True, text=True, timeout=5).stdout.split()
        if not found:
            return None
        d = int(found[0])
        for pid in [d] + _descendants(d):
            for fd in ("0", "1", "2"):
                try:
                    t = os.readlink(f"/proc/{pid}/fd/{fd}")
                except Exception:
                    continue
                if t.startswith("/dev/pts/"):
                    _pty_cache[sock] = t
                    return t
    except Exception as e:
        log(f"pty_for({sock}) failed: {e}")
    return None


def idle_seconds(sock):
    """Seconds since anything was written to this session's terminal.
    None = unknown (no pty); callers should treat that as 'do not gate'."""
    p = pty_for(sock)
    if not p:
        return None
    try:
        return time.time() - os.stat(p).st_mtime
    except Exception:
        _pty_cache.pop(sock, None)
        return None


# A single `dtach -p` push lands in the pty's line-discipline buffer, which the
# kernel caps at N_TTY_BUF_SIZE = 4096 bytes. ANY EXCESS IS DISCARDED SILENTLY —
# dtach still exits 0, so the old code logged "delivered" for a message the
# recipient only received the first 4096 bytes of.
#
# Measured on CT180 2026-07-28 (push N bytes + LF into a scratch dtach session,
# count what arrives):
#     4090 -> 4091 delivered      4200 -> 4096 (105 lost)
#     4000 -> 4001 delivered      6000 -> 4096 (1904 lost)
#                                 8000 -> 4096 (3904 lost)
# Real incident: a 5,914-byte task brief to fable-builder was cut at 4096, the
# trailing 1,818 bytes vanished, and the CR then submitted the mutilated
# fragment. Forwarder logged success.
#
# So: chunk well under the limit and verify we pushed every byte.
CHUNK_BYTES = 3000          # safety margin under the 4096 kernel cap
CHUNK_PAUSE = 0.15          # let the TUI drain between chunks
RETRY_CAP   = 25            # max held-back msgs per agent before we start dropping (loudly)


def _push(sock, payload):
    """One dtach push. Returns True on rc==0."""
    p = subprocess.run(["dtach", "-p", sock], input=payload, text=True, timeout=10)
    if p.returncode != 0:
        log(f"PUSH FAILED rc={p.returncode} on {sock} ({len(payload.encode('utf-8','replace'))} bytes)")
        return False
    return True


def _chunk_utf8(text, limit):
    """Split on UTF-8 byte size without splitting a multi-byte character."""
    out, cur, cur_n = [], [], 0
    for ch in text:
        n = len(ch.encode("utf-8", "replace"))
        if cur_n + n > limit and cur:
            out.append("".join(cur)); cur, cur_n = [], 0
        cur.append(ch); cur_n += n
    if cur:
        out.append("".join(cur))
    return out


def inject(sock, text):
    """Inject text into a dtach pty as if typed, then submit with CR.

    Chunked at CHUNK_BYTES so nothing is lost to the 4096-byte tty buffer.
    """
    if not socket_ok(sock):
        log(f"socket missing: {sock}")
        return False
    try:
        raw = text.encode("utf-8", "replace")
        total = len(raw)
        # Was: full repr + hex of every payload, for the /clear forensics push. That
        # investigation is CLOSED, and the line logged whole message bodies twice at
        # normal level — disk burn plus every DM in plaintext in the journal. Keep the
        # forensic handle (size + a short prefix), drop the payload.
        log(f"INJECT-TEXT {sock} bytes={total} prefix={text[:40]!r}")

        chunks = _chunk_utf8(text, CHUNK_BYTES)
        if len(chunks) > 1:
            log(f"INJECT-CHUNKED {sock} {total} bytes -> {len(chunks)} chunks "
                f"(>{CHUNK_BYTES}B would be truncated at the 4096B tty cap)")

        sent = 0
        for i, c in enumerate(chunks, 1):
            if not _push(sock, c):
                log(f"INJECT-ABORT {sock} after {sent}/{total} bytes "
                    f"(chunk {i}/{len(chunks)}) — message is PARTIAL, not delivering CR")
                return False
            sent += len(c.encode("utf-8", "replace"))
            if i < len(chunks):
                time.sleep(CHUNK_PAUSE)

        if sent != total:
            log(f"INJECT-SHORT {sock} pushed {sent} of {total} bytes — NOT submitting")
            return False

        time.sleep(0.4)
        log(f"INJECT-CR {sock} (bare \\r submit, {sent} bytes in {len(chunks)} chunk(s))")
        subprocess.run(["dtach", "-p", sock], input="\r", text=True, timeout=10)
        return True
    except Exception as e:
        log(f"inject error on {sock}: {e}")
        return False



def turn_in_flight(feed_base, agent):
    """True if this agent is MID-TURN (submitted, thinking, or emitting).

    The pty quiet-gate alone is not enough: between the user pressing enter and
    the model producing its first output, the terminal is SILENT, so a 15s quiet
    window opens and we would inject into a turn already in flight. Observed
    2026-07-28: Travis submitted at ~:33, gate opened at :48, message landed
    mid-turn. The activity collector already distinguishes working from
    idle-awaiting-input, so ask it.

    Returns False on any error — never block delivery because a probe failed.
    """
    try:
        d = http_get(f"{feed_base}/activity?agentId={agent}", timeout=4)
        for a in d.get("activity", []):
            if a.get("agentId") == agent:
                return a.get("state") == "working"
    except Exception as e:
        log(f"activity probe failed for {agent} ({e}) — not blocking delivery")
    return False


def fmt(env):
    who = SENDER_NAMES.get(env.get("from"), env.get("from", "unknown"))
    body = (env.get("body") or "").replace("\r", " ").replace("\n", " ")
    return f"[Relay from {who}]: {body}"


def heartbeat(feed_base, instances):
    """Report per-instance liveness to the bus.

    The broker cannot see dtach sockets, so before 2026-07-28 its `offline`
    status literally meant `kind !== 'local'` — every relay agent read as
    permanently offline even while actively running, which sent me chasing a
    dead relay that was never the problem. We own the sockets, so we are the
    only component that can answer this honestly.
    """
    alive = {a: socket_ok(s) for a, s in instances.items()}
    try:
        http_post(f"{feed_base}/heartbeat",
                  {"agents": [{"agentId": a, "alive": v} for a, v in alive.items()]})
    except Exception as e:
        log(f"heartbeat failed (non-fatal): {e}")
        return alive
    down = [a for a, v in alive.items() if not v]
    if down:
        log(f"heartbeat: sockets MISSING for {down}")
    return alive


def register(feed_base, instances):
    for agent_id in instances:
        try:
            http_post(f"{feed_base}/register",
                      {"agentId": agent_id,
                       "displayName": SENDER_NAMES.get(agent_id, agent_id),
                       "kind": "relay",
                       "relayRecipient": agent_id,
                       "enabled": True})
            log(f"registered {agent_id} (relay)")
        except Exception as e:
            log(f"register {agent_id} failed (non-fatal): {e}")


def main():
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)
    cfg = load_config()
    feed_base = cfg["feed_base"].rstrip("/")
    instances = cfg["instances"]
    poll = int(cfg.get("poll_interval", 5))
    cooldown = int(cfg.get("inject_cooldown", 8))
    quiet_seconds = float(cfg.get("quiet_seconds", QUIET_SECONDS))
    max_defer = float(cfg.get("max_defer_seconds", MAX_DEFER_SECONDS))

    cursor = read_cursor()
    if cursor is None:
        # first run: start at the live tail — do NOT replay backlog
        try:
            cursor = int(http_get(f"{feed_base}/status").get("latestSeq", -1))
        except Exception:
            cursor = -1
        write_cursor(cursor)
        log(f"first run: starting at latestSeq={cursor} (no backlog replay)")

    register(feed_base, instances)
    log(f"serving {list(instances)} | cursor={cursor} | poll={poll}s | "
        f"quiet-gate={quiet_seconds}s (max defer {max_defer}s) | chunk={CHUNK_BYTES}B")
    last_inject = {a: 0.0 for a in instances}
    retry = {a: [] for a in instances}
    deferred_since = {}
    for a, v in read_queue().items():
        if a in retry and isinstance(v, list):
            retry[a] = v[-RETRY_CAP:]
    _held = sum(len(v) for v in retry.values())
    if _held:
        log(f"restored {_held} held msg(s) from {QUEUE_PATH}: "
            + ", ".join(f"{a}={len(v)}" for a, v in retry.items() if v))
    heartbeat(feed_base, instances)

    while running:
        try:
            if os.path.exists(DISABLE_FLAG):
                time.sleep(poll); continue
            heartbeat(feed_base, instances)
            data = http_get(f"{feed_base}/feed?afterSeq={cursor}&limit=200")
            records = data.get("records", [])
            nxt = data.get("nextAfterSeq", cursor)
            # bucket envelopes addressed to local instances
            pending = {a: [] for a in instances}
            for rec in records:
                if rec.get("type") != "envelope":
                    continue
                env = rec.get("envelope", {})
                to = env.get("to")
                frm = env.get("from")
                if to == "broadcast":
                    # fan out to every local instance except the sender (no self-echo)
                    for a in instances:
                        if a != frm:
                            pending[a].append(env)
                elif to in instances:
                    pending[to].append(env)
            # advance + persist cursor BEFORE injecting (so a stuck session
            # can't cause the same message to loop forever)
            if nxt != cursor:
                cursor = nxt
                write_cursor(cursor)
            # Anything that failed to inject last round goes out FIRST, in order.
            # The cursor advances before injection (so a wedged session cannot
            # replay forever), which used to mean a failed delivery was gone for
            # good. Hold it here instead and retry while the backlog is sane.
            for agent_id in instances:
                if retry[agent_id]:
                    pending[agent_id] = retry[agent_id] + pending[agent_id]
                    retry[agent_id] = []
                    write_queue(retry)

            for agent_id, envs in pending.items():
                if not envs:
                    continue
                now = time.time()

                # Quiet-period gate: never type into a terminal someone is using.
                idle = idle_seconds(instances[agent_id])
                mid_turn = turn_in_flight(feed_base, agent_id)
                if mid_turn or (idle is not None and idle < quiet_seconds):
                    held_since = deferred_since.setdefault(agent_id, now)
                    waited = now - held_since
                    if waited < max_defer:
                        retry[agent_id] = (retry[agent_id] + envs)[-RETRY_CAP:]
                        write_queue(retry)
                        why = "MID-TURN (submitted/thinking/emitting)" if mid_turn else \
                              f"terminal active ({idle:.0f}s idle < {quiet_seconds}s)"
                        log(f"DEFERRED -> {agent_id}: {why}, {len(envs)} msg(s) held "
                            f"[waiting {waited:.0f}s/{max_defer}s]")
                        continue
                    log(f"DEFER TIMEOUT -> {agent_id}: still active after {waited:.0f}s, "
                        f"injecting anyway ({len(envs)} msg(s)) — may collide with in-progress input")
                deferred_since.pop(agent_id, None)

                if now - last_inject[agent_id] < cooldown:
                    # leave for next loop by NOT advancing? cursor already advanced;
                    # instead just deliver now — cooldown mainly paces bursts
                    pass
                text = " | ".join(fmt(e) for e in envs)
                if inject(instances[agent_id], text):
                    last_inject[agent_id] = now
                    log(f"delivered {len(envs)} msg(s) -> {agent_id}")
                else:
                    keep = envs[-RETRY_CAP:]
                    lost = len(envs) - len(keep)
                    retry[agent_id] = keep
                    write_queue(retry)
                    log(f"DELIVERY FAILED -> {agent_id}: {len(envs)} msg(s) held for retry"
                        f"{f', {lost} DROPPED (over RETRY_CAP={RETRY_CAP})' if lost else ''}")
            time.sleep(poll)
        except Exception as e:
            log(f"loop error: {e}")
            time.sleep(poll)


if __name__ == "__main__":
    main()
