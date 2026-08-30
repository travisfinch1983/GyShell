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


def tools_for_server(srv):
    """Fully-qualified tool names MCPJungle knows for a server, e.g. pages-wren__page_write.

    A tool group stores TOOL names, not server names: the live groups hold
    memory-<agent>__collection_list and friends. Writing the bare server name is rejected with
    "tool pages-<agent> does not exist or is disabled". The backend hook gets away with pushing a
    bare name because it expands through loadToolRegistry afterwards; this script has to expand
    for itself.
    """
    s, d = call("GET", f"{GW}/api/v0/tools")
    if s != 200:
        return []
    tools = d if isinstance(d, list) else d.get("tools", [])
    names = [(t.get("name") if isinstance(t, dict) else str(t)) for t in tools]
    return sorted(n for n in names if str(n).startswith(f"{srv}__"))


def server_exists(name):
    """True when MCPJungle already has this server.

    Registration is NOT idempotent by status code: a duplicate returns 500 with
    "UNIQUE constraint failed: mcp_servers.name", not 409. Treating 500 as a failure made the
    whole script non-rerunnable -- the first pass registered all 20 servers but lost the group
    update to a discovery race, and every later pass then bailed at registration before it could
    finish the job. Ask what exists instead of inferring it from an error code.
    """
    s, d = call("GET", f"{GW}/api/v0/servers")
    if s != 200:
        return False
    servers = d if isinstance(d, list) else d.get("servers", [])
    return any(str(x.get("name") or "") == name for x in servers)


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

        # Ask what exists rather than inferring it from an error code: a duplicate register
        # returns 500 ("UNIQUE constraint failed"), not 409, so a status-only check makes the
        # script non-rerunnable — which matters because the FIRST pass can register every server
        # and still lose the group update to MCPJungle's tool-discovery lag.
        if server_exists(srv):
            reg_status, reg_body = 200, {}
        else:
            reg_status, reg_body = call("POST", f"{GW}/api/v0/servers", {
                "name": srv, "transport": "streamable_http",
                "url": f"{PAGES}/u/agent:{agent}/mcp", "session_mode": "stateless",
                "description": f"{agent}-scoped Pages authoring — authorship from this path, not a tool argument.",
            })
        already = reg_status == 500 and "UNIQUE constraint" in json.dumps(reg_body)
        if reg_status not in (200, 201, 400, 409) and not already:
            print(f"  ! {agent}: server registration failed ({reg_status}) {json.dumps(reg_body)[:120]}")
            failed += 1
            continue

        # MCPJungle discovers a newly registered server's tools asynchronously, so the very
        # first pass can register everything and still find nothing to add. Skip rather than
        # write a group that would be rejected — re-running then completes the job.
        srv_tools = tools_for_server(srv)
        if not srv_tools:
            print(f"  - {agent}: {srv} registered but its tools are not discovered yet — re-run shortly")
            skipped += 1
            continue

        # Write shape matches backend writeToolGroup: PUT, POST fallback on 404.
        new_tools = list(tools) + srv_tools
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
