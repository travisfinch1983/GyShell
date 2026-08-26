#!/usr/bin/env python3
"""Fleet Relay Watcher — reliable outbound relay for fleet instances that does NOT
depend on Claude Code firing a Stop hook.

For each configured instance, it tails that instance's newest transcript .jsonl,
extracts the FINAL assistant text of the latest turn, and if it ends with a relay
marker `[<x> → <recipient>]` (or `-> <recipient>`) it POSTs the body to the AI-Lab
bus /api/fleet/relay-inbound as { sender, recipient, message }.

Why this exists: the per-instance Stop hook (fleet-relay-stop-hook.py) is not reliably
invoked by Claude Code in long-running sessions (observed on fable-builder: fired at
first, then silently stopped). This watcher is an out-of-band daemon (same pattern as
the fleet-forwarder) so a flaky hook can't drop inter-agent messages.

Dedup cooperates with the Stop hook: it uses the SAME per-agent state file and hash
scheme (sha1(transcript_path + "|" + final_text[:400])). Whichever fires first marks
the hash; the other sees it and skips — redundant delivery, no duplicates.

Config (/opt/fleet-relay-watcher/config.json):
  { "bus": "http://10.0.0.219:17890", "poll": 4,
    "instances": { "<agentId>": "<projects_dir>", ... } }
where <projects_dir> is the Claude Code projects dir to scan for that agent's newest
*.jsonl transcript (recursively; subagent transcripts under subagents/ are ignored).
"""
import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

CONFIG_PATH = os.environ.get("FRW_CONFIG", "/opt/fleet-relay-watcher/config.json")
MARKER = re.compile(r"\[[^\]\n]*?(?:→|->)\s*([a-z0-9][a-z0-9_-]{0,63})\]\s*:?\s*")
LOG = "/tmp/fleet-relay-watcher.log"


def log(msg):
    line = f"[fleet-relay-watcher] {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def newest_transcript(projects_dir):
    """Newest top-level transcript jsonl under projects_dir (skip subagent transcripts)."""
    cands = [
        p for p in glob.glob(os.path.join(projects_dir, "**", "*.jsonl"), recursive=True)
        if "/subagents/" not in p
    ]
    if not cands:
        return None
    return max(cands, key=lambda p: os.path.getmtime(p))


def last_assistant_text(path):
    try:
        with open(path) as f:
            lines = f.readlines()
    except Exception:
        return ""
    for line in reversed(lines):
        try:
            o = json.loads(line)
        except Exception:
            continue
        m = o.get("message") if isinstance(o.get("message"), dict) else o
        is_asst = o.get("type") == "assistant" or (isinstance(m, dict) and m.get("role") == "assistant")
        if not is_asst:
            continue
        c = m.get("content") if isinstance(m, dict) else None
        if isinstance(c, str) and c.strip():
            return c
        if isinstance(c, list):
            t = "".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text").strip()
            if t:
                return t
    return ""


def state_file(agent):
    # Shared with fleet-relay-stop-hook.py so the two cooperate (no double-send).
    return f"/tmp/fleet-relay-hook-{agent}.state"


def seen(agent, h):
    try:
        with open(state_file(agent)) as f:
            return f.read().strip() == h
    except Exception:
        return False


def mark(agent, h):
    try:
        with open(state_file(agent), "w") as f:
            f.write(h)
    except Exception:
        pass


def relay(bus, sender, recipient, message):
    data = json.dumps({"sender": sender, "recipient": recipient, "message": message}).encode()
    req = urllib.request.Request(
        f"{bus.rstrip('/')}/api/fleet/relay-inbound", data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    urllib.request.urlopen(req, timeout=8).read()


def check_instance(bus, agent, projects_dir):
    path = newest_transcript(projects_dir)
    if not path:
        return
    text = last_assistant_text(path)
    if not text:
        return
    m = MARKER.search(text)
    if not m:
        return
    recipient = m.group(1)
    body = text[m.end():].strip()
    if not body:
        return
    h = hashlib.sha1((path + "|" + text[:400]).encode()).hexdigest()
    if seen(agent, h):
        return
    # relay with a few retries across transient bus blips
    last = None
    for i in range(5):
        try:
            relay(bus, agent, recipient, body)
            mark(agent, h)
            log(f"OK {agent} -> {recipient}: {body[:60]!r}")
            return
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(2 ** i, 8))
    log(f"FAIL {agent} -> {recipient} after retries: {last}")




# ─── Real-time liveness (pty), separate from the transcript ──────────────────
# MEASURED 2026-07-28: the transcript is NOT written per-tool-call during a long
# turn. claude1's newest record was 12:32:53 while it was actively running tool
# calls minutes later — transcript idle read 233s and the naive heuristic called
# an actively-working instance "stalled".
#
# So the two sources answer different questions and BOTH are needed:
#   transcript -> WHAT it is doing (tool name, comment, relay marker, ref)
#   pty mtime  -> WHEN it last did anything (real-time; the TUI writes on every
#                 keystroke and every streamed token)
# Liveness therefore uses min(transcript_idle, pty_idle).
_FWD_CONFIG = "/opt/fleet-forwarder/config.json"
_pty_cache = {}


def _sock_for(agent):
    try:
        with open(_FWD_CONFIG) as f:
            return (json.load(f).get("instances") or {}).get(agent)
    except Exception:
        return None


def _pty_for(sock):
    c = _pty_cache.get(sock)
    if c and os.path.exists(c):
        return c
    try:
        found = subprocess.run(["pgrep", "-f", f"dtach -N {sock}"],
                               capture_output=True, text=True, timeout=5).stdout.split()
        if not found:
            return None
        stack, seen = [int(found[0])], []
        while stack:
            pid = stack.pop()
            seen.append(pid)
            try:
                kids = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True,
                                      text=True, timeout=5).stdout.split()
            except Exception:
                kids = []
            stack.extend(int(k) for k in kids)
        for pid in seen:
            for fd in ("0", "1", "2"):
                try:
                    t = os.readlink(f"/proc/{pid}/fd/{fd}")
                except Exception:
                    continue
                if t.startswith("/dev/pts/"):
                    _pty_cache[sock] = t
                    return t
    except Exception:
        pass
    return None


def pty_idle(agent):
    """Seconds since this instance's terminal was last written to. None if unknown."""
    sock = _sock_for(agent)
    if not sock:
        return None
    p = _pty_for(sock)
    if not p:
        return None
    try:
        return max(0.0, time.time() - os.stat(p).st_mtime)
    except Exception:
        _pty_cache.pop(sock, None)
        return None


# ─── Activity reporting ──────────────────────────────────────────────────────
# "Did my message land and is it being worked?" — distinct from presence
# ("is the session reachable"). Source of truth is the TRANSCRIPT, not hooks:
# the per-instance Stop hook was observed on fable-builder to fire at first and
# then silently stop, which is the worst failure mode for a liveness signal —
# it reads as "idle" rather than "unknown".
#
# Claude Code appends every assistant text block and every tool call to the
# session .jsonl in real time with timestamps, so tailing it gives complete
# coverage with no hook to go quiet on us.
_last_shipped = {}
MID_TURN_GRACE = 45   # under this, quiet just means "thinking"


def _rec_summary(rec):
    """(kind, summary) for one transcript record. None if it carries no signal."""
    t = rec.get("type")
    msg = rec.get("message") or {}
    content = msg.get("content")
    if t == "assistant":
        if isinstance(content, list):
            tools = [b.get("name") for b in content
                     if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name")]
            if tools:
                return "tool", "Tool: " + ", ".join(tools[:3])
            texts = [b.get("text", "") for b in content
                     if isinstance(b, dict) and b.get("type") == "text"]
            body = " ".join(texts).strip()
            if body:
                # A relay send is a normal assistant message with a marker.
                m = re.search(r"\[[^\]]*(?:->|→)\s*([A-Za-z0-9_-]+)\]", body)
                if m:
                    return "relay", f"[-> {m.group(1)}]"
                return "text", "Mid-turn comment: " + body[:70].replace("\n", " ")
        elif isinstance(content, str) and content.strip():
            return "text", "Mid-turn comment: " + content[:70].replace("\n", " ")
    elif t == "user":
        if isinstance(content, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return "tool", "Tool result returned"
        if isinstance(content, str) and content.strip():
            return "user_prompt", "User/relay prompt received"
    return None


def activity_for(agent, projects_dir):
    """Build an AgentActivity for one Claude Code instance."""
    now = time.time()
    path = newest_transcript(projects_dir)
    if not path:
        return {"agentId": agent, "kind": "claude-code", "state": "dead",
                "idleSeconds": None, "lastEventKind": "none",
                "lastEventSummary": f"no transcript under {projects_dir}",
                "observedAt": _iso(now)}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()[-400:]
    except Exception as e:
        return {"agentId": agent, "kind": "claude-code", "state": "unknown",
                "idleSeconds": None, "lastEventKind": "none",
                "lastEventSummary": f"transcript unreadable: {e}", "observedAt": _iso(now)}

    kind = summary = ts = None
    uuid = None
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        got = _rec_summary(rec)
        if got:
            kind, summary = got
            ts = rec.get("timestamp")
            uuid = rec.get("uuid")
            break

    # Fall back to file mtime when records carry no usable timestamp.
    last_at = None
    if ts:
        try:
            last_at = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            last_at = None
    if last_at is None:
        try: last_at = os.path.getmtime(path)
        except Exception: last_at = now
    idle = max(0.0, now - last_at)

    # Transcript idle LAGS during a long turn (writes are buffered), so trust
    # whichever source saw activity most recently.
    pidle = pty_idle(agent)
    live_idle = idle if pidle is None else min(idle, pidle)

    if kind is None:
        state = "unknown"
    elif live_idle < MID_TURN_GRACE:
        state = "working"
    elif kind in ("tool",):
        # Quiet MID-TURN on BOTH signals — a tool call with no follow-up is a stall.
        state = "stalled"
    else:
        # Finished speaking and waiting. Idle here is normal, not a fault.
        state = "idle-awaiting-input"

    rec_out = {"agentId": agent, "kind": "claude-code", "state": state,
               "idleSeconds": round(live_idle, 1), "lastEventKind": kind or "none",
               "lastEventSummary": summary or "no recognisable records",
               "lastEventAt": _iso(last_at),
               "ref": f"{path}#{uuid}" if uuid else path,
               "observedAt": _iso(now)}
    # Ship the window only when this agent has ACTED since our last report —
    # otherwise 7 idle agents would push the same few hundred KB every 4s.
    # NOTE: do NOT mark this as shipped here. Marking at build time means a
    # failed POST (e.g. backend mid-restart -> Connection refused) permanently
    # suppresses the window for that uuid. Only a confirmed post may mark it.
    if _last_shipped.get(agent) != uuid:
        rec_out["recent"] = recent_entries(path)
        rec_out["_shipUuid"] = uuid      # stripped before sending
    return rec_out


def _iso(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).isoformat().replace("+00:00", "Z")



RECENT_CAP = 25          # entries shipped with an activity report
RECENT_SUMMARY_CAP = 300 # chars per entry


def recent_entries(path, cap=RECENT_CAP):
    """Tail of a transcript as {role, ts, uuid, summary}, oldest first.

    Shipped BY the collector because the backend (CT152) cannot read these
    files (CT180) — verified ENOENT. Bounded so we are not pushing multi-MB
    transcripts over the wire every poll.
    """
    out = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()[-(cap * 12):]
    except Exception:
        return out
    for line in lines:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") not in ("assistant", "user"):
            continue
        c = (rec.get("message") or {}).get("content")
        summary = ""
        if isinstance(c, list):
            tools = [b.get("name") for b in c if isinstance(b, dict)
                     and b.get("type") == "tool_use" and b.get("name")]
            texts = [b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"]
            nres = sum(1 for b in c if isinstance(b, dict) and b.get("type") == "tool_result")
            if tools:
                summary = "[tool] " + ", ".join(tools)
            elif any(t.strip() for t in texts):
                summary = " ".join(texts).strip()
            elif nres:
                summary = f"[{nres} tool result(s)]"
        elif isinstance(c, str):
            summary = c.strip()
        if not summary:
            continue
        out.append({"role": rec.get("type"), "ts": rec.get("timestamp"),
                    "uuid": rec.get("uuid"),
                    "summary": summary[:RECENT_SUMMARY_CAP].replace("\n", " ")})
    return out[-cap:]


def post_activity(bus, records):
    """Returns True only if the bus accepted the batch."""
    try:
        req = urllib.request.Request(
            f"{bus}/api/fleet/activity",
            data=json.dumps({"activities": records}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=8) as r:
            body = json.loads(r.read().decode() or "{}")
        if body.get("rejected"):
            log(f"activity REJECTED by bus: {body['rejected']}")
            return False
        return True
    except Exception as e:
        log(f"activity post failed (non-fatal): {e}")
        return False


def main():
    cfg = load_config()
    bus = cfg.get("bus", "http://10.0.0.219:17890")
    poll = float(cfg.get("poll", 4))
    instances = cfg.get("instances", {})
    log(f"watching {list(instances)} | bus={bus} | poll={poll}s")
    prev_state = {}
    while True:
        acts = []
        for agent, projects_dir in instances.items():
            try:
                check_instance(bus, agent, projects_dir)
            except Exception as e:  # noqa: BLE001
                log(f"loop error for {agent}: {e}")
            try:
                a = activity_for(agent, projects_dir)
                acts.append(a)
                # Log only TRANSITIONS — a per-poll line for 7 instances every
                # 4s would bury everything else in the journal.
                if prev_state.get(agent) != a["state"]:
                    log(f"{agent}: {prev_state.get(agent, '?')} -> {a['state']} "
                        f"(idle {a['idleSeconds']}s) {a['lastEventSummary'][:60]}")
                    prev_state[agent] = a["state"]
            except Exception as e:  # noqa: BLE001
                log(f"activity error for {agent}: {e}")
        if acts:
            ship = {a.pop("_shipUuid"): a["agentId"] for a in acts if "_shipUuid" in a}
            if post_activity(bus, acts):
                for uid, agent in ship.items():
                    _last_shipped[agent] = uid
            elif ship:
                log(f"post failed — will re-ship recent window for {list(ship.values())} next poll")
        time.sleep(poll)


if __name__ == "__main__":
    main()
