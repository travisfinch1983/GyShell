#!/usr/bin/env python3
"""Probe every cluster container for its real listening ports + identify the service.

Ground truth (no port-guessing): for each running LXC we SSH to its PVE node and run
`pct exec <vmid> ss -Hltnp` to get the actual listening sockets + process names. VMs (no
pct exec) get a TCP-connect scan of common web ports. Every externally-bound port is then
HTTP-probed (status/title/server) and identified via process name -> container name -> title,
with a fingerprint table. Output: /opt/dynacat/cluster-services.json — consumed by the Dynacat
config generator (and, later, the AI-Lab Services tab).
"""
import json, os, re, ssl, subprocess, socket, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

DATA = "/opt/ai-lab/.gybackend-data"
INV = os.path.join(DATA, "inventory.json")
KEY = os.path.join(DATA, "ssh", "id_ed25519")
OUT = "/opt/dynacat/cluster-services.json"
NODE_IP = {"pbs": "10.0.0.17", "px-epyc": "10.0.0.101", "px-gpu": "10.0.0.100",
           "px-micronode": "10.0.0.11", "px-micronode3": "10.0.0.13",
           "px-micronode4": "10.0.0.14", "px-vault": "10.0.0.10"}
SSH = ["ssh", "-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=8"]

# process name -> (friendly app, category). None app => use container name instead.
PROC_MAP = {
    "grafana": ("Grafana", "monitoring"), "grafana-server": ("Grafana", "monitoring"),
    "prometheus": ("Prometheus", "monitoring"), "alertmanager": ("Alertmanager", "monitoring"),
    "uptime-kuma": ("Uptime Kuma", "monitoring"), "node_exporter": ("Node Exporter", "monitoring"),
    "gitea": ("Gitea", "git"), "forgejo": ("Forgejo", "git"),
    "qdrant": ("Qdrant", "vector"), "milvus": ("Milvus", "vector"), "chroma": ("ChromaDB", "vector"),
    "redis-server": ("Redis", "database"), "valkey-server": ("Valkey", "database"),
    "postgres": ("PostgreSQL", "database"), "mariadbd": ("MariaDB", "database"),
    "mysqld": ("MySQL", "database"), "mongod": ("MongoDB", "database"),
    "influxd": ("InfluxDB", "database"), "etcd": ("etcd", "database"), "memcached": ("Memcached", "database"),
    "nginx": ("Nginx", "proxy"), "caddy": ("Caddy", "proxy"), "haproxy": ("HAProxy", "proxy"),
    "traefik": ("Traefik", "proxy"), "npm": ("Nginx Proxy Mgr", "proxy"),
    "jellyfin": ("Jellyfin", "media"), "plex media server": ("Plex", "media"), "plexmediaserver": ("Plex", "media"),
    "frigate": ("Frigate", "nvr"), "go2rtc": ("go2rtc", "nvr"),
    "vaultwarden": ("Vaultwarden", "security"), "minio": ("MinIO", "storage"),
    "mosquitto": ("Mosquitto", "iot"), "homeassistant": ("Home Assistant", "iot"), "hass": ("Home Assistant", "iot"),
    "immich": ("Immich", "photos"), "immich_server": ("Immich", "photos"),
    "llama-server": ("llama.cpp", "llm"), "ollama": ("Ollama", "llm"), "comfyui": ("ComfyUI", "image"),
    "code-server": ("code-server", "dev"), "cockpit-ws": ("Cockpit", "system"),
    "syncthing": ("Syncthing", "sync"), "pihole-ftl": ("Pi-hole", "dns"), "adguardhome": ("AdGuard Home", "dns"),
    "mcpjungle": ("MCPJungle", "ai"),
    # non-UI system daemons -> no app, system category (kept in data, excluded from dashboard)
    "sshd": (None, "system"), "master": (None, "system"), "systemd-resolve": (None, "system"),
    "systemd": (None, "system"), "rpcbind": (None, "system"), "chronyd": (None, "system"),
}
GENERIC = {"node", "python", "python3", "gunicorn", "uvicorn", "docker-proxy", "containerd",
           "dockerd", "java", "ruby", "php", "php-fpm", "beam.smp", "dotnet", "sh", "bash", "su", "deno", "bun"}
SKIP_PORTS = {22, 25, 53, 67, 68, 111, 123, 323, 3493, 5355}  # ssh/smtp/dns/dhcp/rpc/ntp — never web UIs
VM_SCAN_PORTS = [80, 443, 3000, 3001, 5000, 5001, 5601, 7000, 8000, 8006, 8080, 8081, 8086,
                 8096, 8123, 8443, 9000, 9001, 9090, 9443, 2283, 32400, 3389]

PROC_RE = re.compile(r'users:\(\("([^"]+)"')
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return {}


def parse_ss(text):
    """text from `ss -Hltnp` -> list of (port, bind, process)."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("##"):
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        local = parts[3]
        if ":" not in local:
            continue
        addr, _, port = local.rpartition(":")
        try:
            port = int(port)
        except ValueError:
            continue
        m = PROC_RE.search(line)
        proc = m.group(1) if m else ""
        bind = "local" if addr in ("127.0.0.1", "[::1]") else "ext"
        out.append((port, bind, proc))
    return out


def collect_lxc(node, vmids):
    """One SSH per node; section output per vmid. Returns {vmid: [(port,bind,proc)]}."""
    ip = NODE_IP.get(node)
    if not ip:
        return {}
    script = "; ".join(f'echo "##VMID {v}"; pct exec {v} -- ss -Hltnp 2>/dev/null' for v in vmids)
    try:
        txt = subprocess.run(SSH + [f"root@{ip}", script], capture_output=True, text=True, timeout=90).stdout
    except Exception:
        return {}
    res, cur = {}, None
    buf = []
    for line in txt.splitlines():
        if line.startswith("##VMID "):
            if cur is not None:
                res[cur] = parse_ss("\n".join(buf))
            cur = int(line.split()[1]); buf = []
        else:
            buf.append(line)
    if cur is not None:
        res[cur] = parse_ss("\n".join(buf))
    return res


def tcp_open(ip, port, t=1.5):
    try:
        with socket.create_connection((ip, port), timeout=t):
            return True
    except Exception:
        return False


TLS_PORTS = {443, 8443, 9443, 2087, 8006}


def http_probe(ip, port):
    """Return dict(proto,status,server,title) for first HTTP response, else None (non-HTTP)."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    ctx = ssl._create_unverified_context()
    schemes = ("https", "http") if port in TLS_PORTS else ("http", "https")
    for scheme in schemes:
        op = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
        url = f"{scheme}://{ip}:{port}/"
        try:
            r = op.open(urllib.request.Request(url, headers={"User-Agent": "ailab-probe"}), timeout=3)
            body = r.read(4096).decode("utf-8", "ignore")
            tm = TITLE_RE.search(body)
            return {"proto": scheme, "status": r.status, "server": r.headers.get("Server", ""),
                    "title": (tm.group(1).strip()[:60] if tm else "")}
        except urllib.error.HTTPError as e:
            return {"proto": scheme, "status": e.code, "server": (e.headers.get("Server", "") if e.headers else ""),
                    "title": ""}
        except Exception:
            continue  # try https, then give up
    return None


def identify(process, name, title, port):
    p = (process or "").lower()
    if p in PROC_MAP:
        app, cat = PROC_MAP[p]
        return (app or name.title() if app is None else app), cat
    # generic runtime (node/python/...) -> prefer container name, then HTML title
    label = name.replace("-", " ").title() if name else (title or process or "service")
    return label, "app"


def build():
    inv = load(INV)
    guests = [g for g in inv.get("entries", []) if g.get("status") == "running" and g.get("ip")]
    by_node = {}
    vms = []
    for g in guests:
        if g.get("type") == "lxc":
            by_node.setdefault(g.get("node"), []).append(g)
        else:
            vms.append(g)

    # 1) LXC ground-truth via pct exec ss, in parallel per node
    lxc_ports = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(collect_lxc, node, [g["vmid"] for g in gl]): node for node, gl in by_node.items()}
        for f in futs:
            try:
                lxc_ports.update({(futs[f], v): pts for v, pts in f.result().items()})
            except Exception:
                pass

    # 2) assemble candidate (guest, ip, port, bind, process) tuples
    cand = []  # (guest, port, bind, proc)
    for node, gl in by_node.items():
        for g in gl:
            merged = {}  # port -> (bind, proc); dedupe IPv4/IPv6, prefer ext bind
            for port, bind, proc in lxc_ports.get((node, g["vmid"]), []):
                if port not in merged or (bind == "ext" and merged[port][0] == "local"):
                    merged[port] = (bind, proc)
            for port, (bind, proc) in merged.items():
                http = bind == "ext" and port not in SKIP_PORTS
                cand.append((g, port, bind, proc, http))
    for g in vms:  # TCP-scan VMs
        for port in VM_SCAN_PORTS:
            if tcp_open(g["ip"], port):
                cand.append((g, port, "ext", "", True))

    # 3) HTTP-probe externally-bound non-skip ports in parallel
    def probe_one(item):
        g, port, bind, proc, do_http = item
        info = http_probe(g["ip"], port) if do_http else None
        return (g, port, bind, proc, info)

    results = list(ThreadPoolExecutor(max_workers=40).map(probe_one,
              [c for c in cand if c[4]])) + [(c[0], c[1], c[2], c[3], None) for c in cand if not c[4]]

    # 4) group into containers
    containers = {}
    for g, port, bind, proc, info in results:
        c = containers.setdefault(g["vmid"], {"vmid": g["vmid"], "name": g.get("name"), "ip": g.get("ip"),
                                              "node": g.get("node"), "type": g.get("type"), "ports": []})
        if info:
            app, cat = identify(proc, g.get("name", ""), info.get("title", ""), port)
            c["ports"].append({"port": port, "bind": bind, "process": proc, "proto": info["proto"],
                               "status": info["status"], "title": info.get("title", ""),
                               "server": info.get("server", ""), "app": app, "category": cat,
                               "url": f'{info["proto"]}://{g["ip"]}:{port}'})
        else:
            app, cat = identify(proc, g.get("name", ""), "", port)
            c["ports"].append({"port": port, "bind": bind, "process": proc, "proto": "tcp",
                               "app": app if proc else None, "category": cat})

    for c in containers.values():
        c["ports"].sort(key=lambda x: x["port"])
    out = {"generatedAt": int(time.time()), "containers": sorted(containers.values(), key=lambda c: c["vmid"]),
           "nodeIps": NODE_IP}
    return out


if __name__ == "__main__":
    data = build()
    tmp = OUT + ".tmp"
    open(tmp, "w").write(json.dumps(data, indent=1))
    os.replace(tmp, OUT)
    web = sum(1 for c in data["containers"] for p in c["ports"] if p["proto"] in ("http", "https"))
    print(f'{len(data["containers"])} containers, {web} web endpoints -> {OUT}')
