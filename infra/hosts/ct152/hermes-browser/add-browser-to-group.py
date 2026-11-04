#!/usr/bin/env python3
"""add-browser-to-group.py <agent-id>... : put browser-<id>'s tools into tool group agent-<id> (claude1 2026-11-04).
Atomic PUT of the group's full list (current + browser tools). Never includes browser_run_code_unsafe: it runs
arbitrary code in the server process (not the page), and every agent's browser runs as the same uid, so it could
read another agent's profile (cookies, logins) or any readable file on CT152."""
import json, sys, urllib.request
GW = "http://127.0.0.1:8080/api/v0"
EXCLUDE = {"browser_run_code_unsafe"}
def get(p):
    return json.load(urllib.request.urlopen(f"{GW}/{p}", timeout=15))
for a in sys.argv[1:]:
    g = get(f"tool-groups/agent-{a}")
    tools = [t["name"] for t in get(f"tools?server=browser-{a}")]
    add = [t for t in tools if t.split("__", 1)[1] not in EXCLUDE]
    if not add:
        print(f"{a}: browser-{a} has no tools registered"); continue
    cur = g.get("included_tools") or []
    new = cur + [t for t in add if t not in cur]
    new = [t for t in new if not t.endswith("__browser_run_code_unsafe")]
    body = json.dumps({"name": g["name"], "description": g.get("description", ""), "included_servers": [],
                       "included_tools": new, "excluded_tools": []}).encode()
    r = urllib.request.urlopen(urllib.request.Request(f"{GW}/tool-groups/agent-{a}", data=body, method="PUT",
                                                      headers={"Content-Type": "application/json"}), timeout=15)
    after = get(f"tool-groups/agent-{a}")["included_tools"]
    nb = sum(1 for t in after if t.startswith(f"browser-{a}__"))
    print(f"{a}: HTTP {r.status}, group {len(cur)} -> {len(after)} tools ({nb} browser, unsafe present: {any('run_code_unsafe' in t for t in after)})")
