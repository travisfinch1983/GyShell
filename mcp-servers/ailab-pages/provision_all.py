#!/usr/bin/env python3
"""Provision the THREE authoring toolsets across the fleet. Idempotent.

  pages-<agent>    → /pages/u/agent:<agent>/mcp      scoping documents   → ALL agents
  reports-<agent>  → /reports/u/agent:<agent>/mcp    typed reports       → ALL agents
  journal-<agent>  → /journal/u/agent:<agent>/mcp    the working log     → JOURNAL_AGENTS

Separate servers, not one mixed toolset: an agent that files security-camera
reports must not see journal tools, and nothing should land in the wrong section
by accident (Travis, 2026-08-30). Journal recipients are a list because the
journal is a working log belonging to specific agents, not a fleet-wide surface.

🛑 MCPJUNGLE CACHES TOOL SCHEMAS AT REGISTRATION and does not re-enumerate when
the upstream server restarts (claude1, 2026-08-30 — his correct deploy sat
behind a stale cache). So:
  - an EXISTING server whose toolset changed must be re-registered with --force;
  - restarting the MCP process alone changes nothing a caller can see;
  - and verification must go THROUGH THE GATEWAY, never against the server.
This script does all three: force-refreshes, then counts tools via the gateway.

Guards carried from the memory provisioner: the agent list comes from the real
profile API (a typo mints a working-but-wrong identity), tool groups are read /
EXTENDED / written back — never replaced — and every agent is verified after.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

GW = os.environ.get("MCPJUNGLE_URL", "http://127.0.0.1:8080")
API = os.environ.get("AILAB_API_URL", "http://127.0.0.1:17890")
MCP = os.environ.get("AILAB_AUTHORING_MCP_URL", "http://127.0.0.1:9848")
MCPJUNGLE_BIN = os.environ.get("MCPJUNGLE_BIN", "mcpjungle")
# Journal is a working log, so it belongs to the agents that keep one.
JOURNAL_AGENTS = [a.strip() for a in os.environ.get(
    "AILAB_JOURNAL_AGENTS", "maintenance-claude").split(",") if a.strip()]

TOOLSETS = [("pages", "scoping documents"), ("reports", "typed reports"), ("journal", "working log")]


def call(method, url, payload=None, timeout=45):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode() if payload is not None else None,
        method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read()
            return r.status, (json.loads(b) if b else {})
    except urllib.error.HTTPError as e:
        b = e.read()
        try:
            return e.code, json.loads(b)
        except Exception:
            return e.code, {"raw": b.decode(errors="replace")[:300]}
    except Exception as e:
        return 0, {"raw": str(e)}


def servers():
    _, d = call("GET", f"{GW}/api/v0/servers")
    rows = d if isinstance(d, list) else d.get("servers", [])
    return {r.get("name"): r for r in rows if isinstance(r, dict)}


def gateway_tools(server_name):
    """Tools the GATEWAY will actually serve — the only view any agent sees."""
    _, d = call("GET", f"{GW}/api/v0/tools?server={server_name}")
    rows = d if isinstance(d, list) else d.get("tools", [])
    return [t.get("name") for t in rows if isinstance(t, dict)]


def register(name, url, description, force):
    """No in-place refresh exists in MCPJungle; --force deregisters + re-registers."""
    cfg = {"name": name, "transport": "streamable_http", "url": url,
           "description": description, "session_mode": "stateless"}
    if not force:
        s, _ = call("POST", f"{GW}/api/v0/servers", cfg)
        # A duplicate returns 500 UNIQUE-constraint, not 409 — never infer from the code.
        return s in (200, 201)
    path = f"/tmp/.reg-{name}.json"
    with open(path, "w") as f:
        json.dump(cfg, f)
    try:
        p = subprocess.run([MCPJUNGLE_BIN, "register", "--force", "-c", path],
                           capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            print(f"    register --force failed: {(p.stderr or p.stdout).strip()[:200]}")
        return p.returncode == 0
    except FileNotFoundError:
        print(f"    {MCPJUNGLE_BIN} not on PATH — cannot force-refresh {name}")
        return False
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    s, health = call("GET", f"{MCP}/health", timeout=5)
    if s != 200:
        print(f"FATAL: authoring MCP not healthy at {MCP} ({s}) — start it first")
        sys.exit(1)
    print(f"authoring MCP toolsets: {', '.join(health.get('toolsets', []))}")

    s, d = call("GET", f"{API}/api/hermes/agents")
    if s != 200:
        print(f"FATAL: cannot list agents ({s})")
        sys.exit(1)
    agents = d.get("agents", [])
    # The Hermes roster is not the whole fleet. A Claude Code instance -- maintenance-claude
    # is the case that matters -- is not a Hermes agent, so it never appeared here, and the
    # journal toolset exists FOR it. Union the journal agents in or the one toolset with a
    # named owner is the one that never gets provisioned.
    missing = [a for a in JOURNAL_AGENTS if a not in agents]
    agents = list(agents) + missing
    print(f"{len(agents)} agents ({len(missing)} from JOURNAL_AGENTS, not Hermes); "
          f"journal → {', '.join(JOURNAL_AGENTS)}\n")

    existing = servers()
    ok = failed = 0
    for agent in agents:
        group_name = f"agent-{agent}"
        s, group = call("GET", f"{GW}/api/v0/tool-groups/{group_name}")
        # No tool group is not the same as nothing to do. Hermes agents are scoped by a
        # group; a Claude Code instance reaches the gateway unscoped and sees every tool,
        # so it needs the SERVERS registered and has no group to update. Skipping it left
        # maintenance-claude without the toolset built for it.
        grouped = s == 200
        if not grouped:
            print(f"  · {agent}: no tool group (unscoped gateway client) — registering servers only")
        current = (group.get("included_tools") or []) if grouped else []
        want_names = []

        for toolset, what in TOOLSETS:
            if toolset == "journal" and agent not in JOURNAL_AGENTS:
                continue
            name = f"{toolset}-{agent}"
            url = f"{MCP}/{toolset}/u/agent:{agent}/mcp"
            prior = existing.get(name)
            # Force-refresh when the server exists (its toolset may have changed);
            # plain register when new. Either way we VERIFY through the gateway below.
            if not register(name, url, f"{agent}-scoped {what} — authorship from the caller path, not a tool argument.", force=bool(prior)):
                print(f"  ! {agent}: could not register {name}")
                failed += 1
                continue
            tools = gateway_tools(name)
            if not tools:
                print(f"  ! {agent}: {name} registered but the GATEWAY reports 0 tools — not adding to the group")
                failed += 1
                continue
            want_names.extend(tools)

        if not grouped:
            # Verify the same way, through the gateway, just without a group to read back.
            have = {ts for ts, _ in TOOLSETS if gateway_tools(f"{ts}-{agent}")}
            expected = {ts for ts, _ in TOOLSETS if ts != "journal" or agent in JOURNAL_AGENTS}
            if have == expected:
                print(f"  + {agent}: {', '.join(sorted(have))} (servers registered, no group)")
                ok += 1
            else:
                print(f"  ! {agent}: VERIFY FAILED — expected {sorted(expected)}, gateway shows {sorted(have)}")
                failed += 1
            continue
        if not want_names:
            continue
        # Drop this agent's stale authoring tools, keep everything else untouched,
        # then add what the gateway actually serves now.
        keep = [t for t in current if not any(t.startswith(f"{ts}-{agent}__") for ts, _ in TOOLSETS)]
        merged = sorted(set(keep) | set(want_names))
        if merged == sorted(set(current)):
            print(f"  = {agent}: already current ({len(merged)} tools)")
            ok += 1
            continue
        body = {"name": group_name, "description": group.get("description") or f"AI-Lab tool set for {agent}",
                "included_servers": [], "included_tools": merged, "excluded_tools": []}
        s, d = call("PUT", f"{GW}/api/v0/tool-groups/{group_name}", body)
        if s == 404:
            s, d = call("POST", f"{GW}/api/v0/tool-groups", body)
        if s not in (200, 201):
            print(f"  ! {agent}: group update failed ({s}) {str(d)[:140]}")
            failed += 1
            continue
        s, after = call("GET", f"{GW}/api/v0/tool-groups/{group_name}")
        got = (after or {}).get("included_tools") or []
        have = {ts for ts, _ in TOOLSETS if any(t.startswith(f"{ts}-{agent}__") for t in got)}
        expected = {ts for ts, _ in TOOLSETS if ts != "journal" or agent in JOURNAL_AGENTS}
        if have == expected:
            print(f"  + {agent}: {', '.join(sorted(have))} ({len(current)} → {len(got)} tools)")
            ok += 1
        else:
            print(f"  ! {agent}: VERIFY FAILED — expected {sorted(expected)}, gateway shows {sorted(have)}")
            failed += 1

    print(f"\ndone: {ok} ok, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
