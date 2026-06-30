#!/usr/bin/env python3
"""Generate /opt/dynacat/dynacat.yml from AI-Lab inventory + the cluster probe.

Two sources:
  - active-services.json  -> AI services (LLM/TTS/Tools), grouped by serviceType, model labels,
                             LLMs health-checked at /health.
  - cluster-services.json  (from cluster-probe.py) -> every other container's real web endpoints,
                             one PRIMARY endpoint per container, grouped by PVE node. Because the probe
                             confirmed the port is listening + returns HTTP, the monitor uses a broad
                             alt-status-codes (301/401/404... = OK) so reachable services show green.
News/feeds static. Idempotent: validates + only rewrites/restarts dynacat on change.
"""
import json, os, subprocess, sys

DATA = "/opt/ai-lab/.gybackend-data"
ACTIVE = os.path.join(DATA, "active-services.json")
CLUSTER = os.path.join(DATA, "cluster-services.json")
OUT = "/opt/dynacat/dynacat.yml"

AI_TYPES = {"llm", "tts", "stt", "tools", "image", "embed", "rerank", "ai"}  # owned by the AI section
TYPE_TITLE = {"llm": "LLM Endpoints", "tts": "TTS / Voice", "stt": "STT", "tools": "Tools",
              "image": "Image Gen", "embed": "Embeddings", "rerank": "Rerankers"}
NODE_ORDER = ["pbs", "px-epyc", "px-gpu", "px-vault", "px-micronode", "px-micronode3", "px-micronode4"]
NODE_TITLE = {"pbs": "pbs", "px-epyc": "px-epyc", "px-gpu": "px-gpu", "px-vault": "px-vault",
              "px-micronode": "micronode-1", "px-micronode3": "micronode-3", "px-micronode4": "micronode-4"}
ALT_CODES = "[301, 302, 303, 307, 308, 400, 401, 403, 404]"  # reachable-but-non-200 still = up

RSS_FEEDS = [("Hacker News", "https://news.ycombinator.com/rss"),
             ("The Register", "https://www.theregister.com/headlines.atom"),
             ("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index")]
SUBREDDITS = ["selfhosted", "LocalLLaMA", "homelab"]


def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return {}


def q(s):
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def short(s, n=42):
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def base(ep):
    e = ep.rstrip("/")
    if "://" not in e:
        return e
    sc, rest = e.split("://", 1)
    return sc + "://" + rest.split("/", 1)[0]


# ---- AI services from active-services.json ----
def ai_groups():
    d = load(ACTIVE)
    svcs = d.get("services", d)
    vals = list(svcs.values()) if isinstance(svcs, dict) else (svcs or [])
    groups = {}
    for v in vals:
        if not isinstance(v, dict) or not v.get("endpoint"):
            continue
        st = (v.get("serviceType") or "other").lower()
        label = short(v.get("model")) if v.get("model") else (v.get("providerName") or "service")
        url = base(v["endpoint"]) + ("/health" if st == "llm" else "")
        groups.setdefault(st, []).append({"label": label, "url": url, "port": v.get("port")})
    for items in groups.values():
        cnt = {}
        for it in items:
            cnt[it["label"]] = cnt.get(it["label"], 0) + 1
        for it in items:
            if cnt[it["label"]] > 1 and it.get("port"):
                it["label"] += f' :{it["port"]}'
    return groups


# ---- cluster web services from the probe: one primary endpoint per container ----
def primary(ports):
    web = [p for p in ports if p.get("proto") in ("http", "https")]
    if not web:
        return None

    def score(p):
        s = 0
        st = p.get("status", 0)
        if 200 <= st < 400:
            s += 3
        if p.get("app") and p["app"].lower() not in ("nginx", "caddy", "apache", "traefik"):
            s += 1
        if p["port"] not in (80, 443):
            s += 1
        return (s, -p["port"])  # higher score, then lower port
    return sorted(web, key=score, reverse=True)[0]


def cluster_by_node():
    d = load(CLUSTER)
    nodes = {}
    for c in d.get("hosts", []):
        if c.get("guestType") == "node":  # PVE nodes live in the Services tab, not the dashboard
            continue
        p = primary(c.get("services", []))
        if not p or p.get("category") in AI_TYPES:  # AI endpoints handled by the AI section
            continue
        label = p.get("app") or c.get("hostName") or "service"
        nodes.setdefault(c.get("node") or "other", []).append(
            {"label": label, "url": p["url"], "https": p["proto"] == "https", "icon": p.get("icon")})
    for items in nodes.values():
        items.sort(key=lambda x: x["label"].lower())
    return nodes


def monitor(title, sites, cache, indent=10, alt=True):
    pad, p2, p3 = " " * indent, " " * (indent + 2), " " * (indent + 4)
    out = [f"{pad}- type: monitor", f"{p2}title: {q(title)}", f"{p2}cache: {cache}", f"{p2}sites:"]
    for s in sites:
        out.append(f"{p3}- title: {q(s['label'])}")
        out.append(f"{p3}  url: {q(s['url'])}")
        if s.get("icon"):
            out.append(f"{p3}  icon: {q('di:' + s['icon'])}")  # dashboard-icons
        if alt:
            out.append(f"{p3}  alt-status-codes: {ALT_CODES}")
        if s.get("https"):
            out.append(f"{p3}  allow-insecure: true")
    return "\n".join(out)


def build():
    ai = ai_groups()
    nodes = cluster_by_node()
    L = ["# AUTO-GENERATED by gen-dynacat-config.py (sources: active-services.json + cluster-services.json).",
         "# Do not hand-edit — run /opt/dynacat/refresh.sh to regenerate.",
         "server:", "  host: 127.0.0.1", "  port: 8081", "  base-url: /dash",
         "  allowed-embed-hosts:", "    - https://ai-lab.deeveeyant.com", "",
         "pages:"]

    # Page 1: AI Services
    L += ["  - name: AI Services", "    columns:",
          "      - size: small", "        widgets:",
          "          - type: server-stats", "            servers:",
          "              - type: local", f"                name: {q('CT152 · AI-Lab')}",
          "          - type: hacker-news", "            limit: 10",
          "      - size: full", "        widgets:"]
    if ai:
        for st in sorted(ai, key=lambda k: (k != "llm", k)):
            L.append(monitor(TYPE_TITLE.get(st, st.capitalize()), ai[st], "30s"))
    else:
        L += ["          - type: rss", f"            title: {q('(no active AI services)')}",
              "            feeds:", f"              - url: {q(RSS_FEEDS[0][1])}"]

    # Page 2: Cluster (every container's primary web endpoint, grouped by node)
    L += ["  - name: Cluster", "    columns:"]
    ordered = [n for n in NODE_ORDER if n in nodes] + [n for n in nodes if n not in NODE_ORDER]
    # split nodes across 2 full columns roughly evenly by site count (Dynacat allows max 2 full cols)
    cols = [[], []]
    load_ = [0, 0]
    for n in ordered:
        i = load_.index(min(load_))
        cols[i].append(n)
        load_[i] += len(nodes[n]) + 2
    for col in cols:
        L += ["      - size: full", "        widgets:"]
        if not col:
            L += ["          - type: rss", f"            title: {q('—')}", "            feeds:",
                  f"              - url: {q(RSS_FEEDS[0][1])}"]
        for n in col:
            L.append(monitor(f"{NODE_TITLE.get(n, n)} ({len(nodes[n])})", nodes[n], "2m"))

    # Page 3: News
    L += ["  - name: News", "    columns:", "      - size: full", "        widgets:",
          "          - type: rss", f"            title: {q('Feeds')}", "            style: detailed-list",
          "            limit: 25", "            feeds:"]
    for t, u in RSS_FEEDS:
        L += [f"              - url: {q(u)}", f"                title: {q(t)}"]
    L += ["      - size: small", "        widgets:"]
    for sub in SUBREDDITS:
        L += ["          - type: reddit", f"            subreddit: {q(sub)}", "            limit: 8"]
    return "\n".join(L) + "\n"


def main():
    # If the user hand-edited the config via the AI-Lab Home editor, a sentinel pauses auto-regen so their
    # edits aren't clobbered. POST /api/dynacat/regenerate (the "Reset to auto-generated" button) clears it.
    if os.path.exists("/opt/dynacat/.manual-override"):
        print("manual override active — skipping regen (Home editor owns dynacat.yml)")
        return
    new = build()
    old = open(OUT).read() if os.path.exists(OUT) else ""
    if new == old:
        print("no change")
        return
    tmp = OUT + ".tmp"
    open(tmp, "w").write(new)
    v = subprocess.run(["/opt/dynacat/dynacat", "-config", tmp, "config:validate"], capture_output=True, text=True)
    if v.returncode != 0:
        sys.stderr.write("VALIDATION FAILED:\n" + v.stdout + v.stderr + "\n")
        os.remove(tmp)
        sys.exit(1)
    os.replace(tmp, OUT)
    subprocess.run(["systemctl", "restart", "dynacat"], check=False)
    print("config updated + dynacat restarted")


if __name__ == "__main__":
    main()
