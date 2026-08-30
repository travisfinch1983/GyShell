#!/usr/bin/env python3
"""Give EVERY existing Hermes agent the pages-<agent> toolset. Idempotent, one-shot.

New/edited agents get this automatically via ensureMemoryNamespaceAndFleet in
HermesManagementService; this script converges the agents that already exist.

Guards inherited from adapters/provision_agent.py (the memory provisioning script):
 - agent list comes from the REAL profile API, never typed by hand (the pages service
   answers ANY /u/<ns>/mcp path, so a typo mints a working-but-wrong author identity);
 - BOTH halves or neither: register the server AND extend the tool group;
 - tool groups are read, EXTENDED and written back — never replaced, never shrunk;
 - verify after: the group must actually contain pages-<agent>__ tools when done.
"""
import json
import sys
import urllib.error
import urllib.request

GW = "http://127.0.0.1:8080"
API = "http://127.0.0.1:17890"
PAGES = "http://127.0.0.1:9848"


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


def get_group(name):
    """Matches backend toolGroups.ts: GET returns {included_tools:[...]} or 404."""
    s, d = call("GET", f"{GW}/api/v0/tool-groups/{name}")
    if s != 200:
        return None
    return d


def main():
    s, d = call("GET", f"{PAGES}/health", timeout=5)
    if s != 200:
        print(f"FATAL: pages MCP not healthy on {PAGES} ({s}) — start ai-lab-pages-mcp first")
        sys.exit(1)

    s, d = call("GET", f"{API}/api/hermes/agents")
    if s != 200:
        print(f"FATAL: cannot list agents ({s})")
        sys.exit(1)
    agents = d.get("agents", [])
    print(f"{len(agents)} agents")

    ok = skipped = failed = 0
    for agent in agents:
        srv = f"pages-{agent}"
        group_name = f"agent-{agent}"
        group = get_group(group_name)
        if group is None:
            print(f"  - {agent}: no tool group {group_name}, skipping (not a gateway agent)")
            skipped += 1
            continue
        tools = group.get("included_tools") or []
        if any(str(t).startswith("pages-") for t in tools):
            print(f"  = {agent}: already has pages tools")
            skipped += 1
            continue

        s, _ = call("POST", f"{GW}/api/v0/servers", {
            "name": srv, "transport": "streamable_http",
            "url": f"{PAGES}/u/agent:{agent}/mcp", "session_mode": "stateless",
            "description": f"{agent}-scoped Pages authoring — authorship from this path, not a tool argument.",
        })
        if s not in (200, 201, 400, 409):
            print(f"  ! {agent}: server registration failed ({s})")
            failed += 1
            continue

        # Write shape matches backend writeToolGroup: PUT, POST fallback on 404.
        new_tools = list(tools) + [srv]  # bare server name expands to all its tools
        body = {"name": group_name,
                "description": group.get("description") or f"AI-Lab tool set for {agent}",
                "included_servers": [], "included_tools": new_tools, "excluded_tools": []}
        s, d = call("PUT", f"{GW}/api/v0/tool-groups/{group_name}", body)
        if s == 404:
            s, d = call("POST", f"{GW}/api/v0/tool-groups", body)
        if s not in (200, 201):
            print(f"  ! {agent}: group update failed ({s}) {str(d)[:120]}")
            failed += 1
            continue

        after = get_group(group_name) or {}
        got = after.get("included_tools") or []
        if any(str(t).startswith(f"pages-{agent}") for t in got) or srv in got:
            print(f"  + {agent}: pages tools added ({len(tools)} -> {len(got)})")
            ok += 1
        else:
            print(f"  ! {agent}: VERIFY FAILED — group written but pages tools not present")
            failed += 1

    print(f"\ndone: {ok} provisioned, {skipped} skipped, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
