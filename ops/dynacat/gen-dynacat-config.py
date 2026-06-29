#!/usr/bin/env python3
"""Generate /opt/dynacat/dynacat.yml from AI-Lab's cluster inventory.

Dynamic AI services come from active-services.json (endpoint/serviceType/model/provider).
Infra services resolve their IP from inventory.json by guest name (so IP changes are picked
up automatically); ports are conventional/best-effort and easy to tune in INFRA below.
News/feeds are static. Re-runnable + idempotent: only rewrites + restarts dynacat on change.
"""
import json, os, subprocess, sys

DATA = "/opt/ai-lab/.gybackend-data"
ACTIVE = os.path.join(DATA, "active-services.json")
INV = os.path.join(DATA, "inventory.json")
OUT = "/opt/dynacat/dynacat.yml"

# Infra services: (label, inventory-name, port, scheme, path). IP resolved from inventory by name.
# inventory-name=None means use the fixed IP in FIXED below. Ports are best-effort — tune as needed.
INFRA = [
    ("AI-Lab",         None,             17889, "http",  ""),
    ("Grafana",        "grafana",        3000,  "http",  ""),
    ("Prometheus",     "prometheus",     9090,  "http",  ""),
    ("Gitea",          "gitea",          3000,  "http",  ""),
    ("MCPJungle",      "mcpjungle",      8080,  "http",  ""),
    ("Immich",         "immich",         2283,  "http",  ""),
    ("Home Assistant", "home-assistant", 8123,  "http",  ""),
    ("Jellyfin",       "jellyfin",       8096,  "http",  ""),
    ("Frigate",        "frigate",        5000,  "http",  ""),
    ("Nextcloud",      "nextcloud",      443,   "https", ""),
    ("Qdrant",         "qdrant",         6333,  "http",  "/dashboard"),
    ("MinIO Console",  "minio",          9001,  "http",  ""),
]
FIXED = {"AI-Lab": "10.0.0.219"}

# Static news feeds.
RSS_FEEDS = [
    ("Hacker News",  "https://news.ycombinator.com/rss"),
    ("The Register", "https://www.theregister.com/headlines.atom"),
    ("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
]
SUBREDDITS = ["selfhosted", "LocalLLaMA", "homelab"]

# serviceType -> display title for its monitor widget.
TYPE_TITLE = {"llm": "LLM Endpoints", "tts": "TTS / Voice", "stt": "STT", "tools": "Tools", "image": "Image Gen"}


def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return {}


def q(s):
    """Double-quote a YAML scalar, escaping backslashes and quotes."""
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def base(endpoint):
    """scheme://host:port from a full endpoint URL (drop any path)."""
    e = endpoint.rstrip("/")
    if "://" not in e:
        return e
    scheme, rest = e.split("://", 1)
    return scheme + "://" + rest.split("/", 1)[0]


def short(s, n=42):
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def ai_groups():
    """Return ordered dict serviceType -> list of (label, url) from active-services.json."""
    d = load(ACTIVE)
    svcs = d.get("services", d)
    vals = list(svcs.values()) if isinstance(svcs, dict) else (svcs or [])
    groups = {}
    for v in vals:
        if not isinstance(v, dict):
            continue
        ep = v.get("endpoint")
        if not ep:
            continue
        st = (v.get("serviceType") or "other").lower()
        provider = v.get("providerName") or v.get("providerId") or "service"
        model = v.get("model")
        port = v.get("port")
        label = short(model) if model else provider
        # LLM up/down via /health (both llama.cpp + vLLM expose it); others check the base.
        url = base(ep) + ("/health" if st == "llm" else "")
        groups.setdefault(st, []).append({"label": label, "url": url, "port": port, "provider": provider})
    # disambiguate duplicate labels within a group by appending the port
    for st, items in groups.items():
        seen = {}
        for it in items:
            seen[it["label"]] = seen.get(it["label"], 0) + 1
        for it in items:
            if seen[it["label"]] > 1 and it.get("port"):
                it["label"] = f'{it["label"]} :{it["port"]}'
    return groups


def infra_sites():
    inv = load(INV)
    by_name = {(e.get("name") or "").lower(): e for e in inv.get("entries", [])}
    out = []
    for label, name, port, scheme, path in INFRA:
        ip = FIXED.get(label) if name is None else (by_name.get(name, {}) or {}).get("ip")
        if not ip:
            continue
        out.append((label, f"{scheme}://{ip}:{port}{path}", scheme == "https"))
    return out


def monitor_widget(title, sites, cache="1m", indent=10):
    """sites: list of (label, url, allow_insecure)."""
    pad = " " * indent
    p2 = " " * (indent + 2)
    p3 = " " * (indent + 4)
    out = [f"{pad}- type: monitor", f"{p2}title: {q(title)}", f"{p2}cache: {cache}", f"{p2}sites:"]
    for label, url, insecure in sites:
        out.append(f"{p3}- title: {q(label)}")
        out.append(f"{p3}  url: {q(url)}")
        if insecure:
            out.append(f"{p3}  allow-insecure: true")
    return "\n".join(out)


def build():
    groups = ai_groups()
    L = []
    L.append("# AUTO-GENERATED by gen-dynacat-config.py from AI-Lab inventory. Edits will be overwritten.")
    L.append("server:")
    L.append("  host: 127.0.0.1")
    L.append("  port: 8081")
    L.append("  base-url: /dash")
    L.append("  allowed-embed-hosts:")
    L.append("    - https://ai-lab.deeveeyant.com")
    L.append("")
    L.append("pages:")
    L.append("  - name: Lab")
    L.append("    columns:")
    # left column: host stats + infra monitor
    L.append("      - size: small")
    L.append("        widgets:")
    L.append("          - type: server-stats")
    L.append("            servers:")
    L.append("              - type: local")
    L.append(f"                name: {q('CT152 · AI-Lab')}")
    inf = infra_sites()
    if inf:
        L.append(monitor_widget("Infrastructure", inf, cache="2m"))
    # middle column: AI service monitors grouped by type (LLM first)
    L.append("      - size: full")
    L.append("        widgets:")
    order = sorted(groups.keys(), key=lambda k: (k != "llm", k))
    if not order:
        L.append("          - type: rss")
        L.append("            title: " + q("(no active AI services found)"))
        L.append("            feeds:")
        L.append("              - url: " + q(RSS_FEEDS[0][1]))
    for st in order:
        sites = [(it["label"], it["url"], False) for it in groups[st]]
        L.append(monitor_widget(TYPE_TITLE.get(st, st.capitalize()), sites, cache="30s"))
    # right column: hacker news
    L.append("      - size: small")
    L.append("        widgets:")
    L.append("          - type: hacker-news")
    L.append("            limit: 12")
    # News page
    L.append("  - name: News")
    L.append("    columns:")
    L.append("      - size: full")
    L.append("        widgets:")
    L.append("          - type: rss")
    L.append("            title: " + q("Feeds"))
    L.append("            style: detailed-list")
    L.append("            limit: 25")
    L.append("            feeds:")
    for title, url in RSS_FEEDS:
        L.append("              - url: " + q(url))
        L.append("                title: " + q(title))
    L.append("      - size: small")
    L.append("        widgets:")
    for sub in SUBREDDITS:
        L.append("          - type: reddit")
        L.append("            subreddit: " + q(sub))
        L.append("            limit: 8")
    return "\n".join(L) + "\n"


def main():
    new = build()
    old = open(OUT).read() if os.path.exists(OUT) else ""
    if new == old:
        print("no change")
        return
    tmp = OUT + ".tmp"
    open(tmp, "w").write(new)
    v = subprocess.run(["/opt/dynacat/dynacat", "-config", tmp, "config:validate"],
                       capture_output=True, text=True)
    if v.returncode != 0:
        sys.stderr.write("VALIDATION FAILED, keeping old config:\n" + v.stdout + v.stderr + "\n")
        os.remove(tmp)
        sys.exit(1)
    os.replace(tmp, OUT)
    subprocess.run(["systemctl", "restart", "dynacat"], check=False)
    print("config updated + dynacat restarted")


if __name__ == "__main__":
    main()
