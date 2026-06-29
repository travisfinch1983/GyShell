#!/usr/bin/env python3
"""Probe every cluster host/container for real listening ports + identify the service.

Ground truth (no port-guessing): each running LXC -> SSH to its PVE node -> `pct exec <vmid> ss -Hltnp`
for actual listening sockets + process names. PVE nodes themselves -> `ss -Hltnp` directly. VMs -> TCP
scan of common web ports. Every externally-bound port is HTTP-probed (status/title/server) and identified:
process name -> community-scripts catalog (by container name) -> HTML title, with a fingerprint table,
category, and a dashboard-icons slug. Output -> AI-Lab's data dir (consumed by the native /api/discovery
router AND the Dynacat config generator).
"""
import json, os, re, ssl, socket, subprocess, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

DATA = "/opt/ai-lab/.gybackend-data"
INV = os.path.join(DATA, "inventory.json")
KEY = os.path.join(DATA, "ssh", "id_ed25519")
OUT = os.path.join(DATA, "cluster-services.json")
CATALOG = os.path.join(DATA, "script-catalog.json")  # cached community-scripts slug list
NODE_IP = {"pbs": "10.0.0.17", "px-epyc": "10.0.0.101", "px-gpu": "10.0.0.100",
           "px-micronode": "10.0.0.11", "px-micronode3": "10.0.0.13",
           "px-micronode4": "10.0.0.14", "px-vault": "10.0.0.10"}
SSH = ["ssh", "-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=8"]

# process name -> (friendly app, category). None app => fall back to container name.
PROC_MAP = {
    "grafana": ("Grafana", "monitoring"), "grafana-server": ("Grafana", "monitoring"),
    "prometheus": ("Prometheus", "monitoring"), "alertmanager": ("Alertmanager", "monitoring"),
    "uptime-kuma": ("Uptime Kuma", "monitoring"), "node_exporter": ("Node Exporter", "monitoring"),
    "zabbix_server": ("Zabbix", "monitoring"),
    "gitea": ("Gitea", "dev"), "forgejo": ("Forgejo", "dev"), "code-server": ("code-server", "dev"),
    "qdrant": ("Qdrant", "database"), "milvus": ("Milvus", "database"), "chroma": ("ChromaDB", "database"),
    "redis-server": ("Redis", "database"), "valkey-server": ("Valkey", "database"),
    "postgres": ("PostgreSQL", "database"), "mariadbd": ("MariaDB", "database"),
    "mysqld": ("MySQL", "database"), "mongod": ("MongoDB", "database"),
    "influxd": ("InfluxDB", "database"), "etcd": ("etcd", "database"), "memcached": ("Memcached", "database"),
    "nginx": ("Nginx", "network"), "caddy": ("Caddy", "network"), "haproxy": ("HAProxy", "network"),
    "traefik": ("Traefik", "network"), "adguardhome": ("AdGuard Home", "network"), "pihole-ftl": ("Pi-hole", "network"),
    "jellyfin": ("Jellyfin", "media"), "plex media server": ("Plex", "media"), "plexmediaserver": ("Plex", "media"),
    "frigate": ("Frigate", "media"), "go2rtc": ("go2rtc", "media"),
    "vaultwarden": ("Vaultwarden", "security"), "authelia": ("Authelia", "security"),
    "minio": ("MinIO", "storage"), "syncthing": ("Syncthing", "storage"),
    "mosquitto": ("Mosquitto", "automation"), "homeassistant": ("Home Assistant", "automation"), "hass": ("Home Assistant", "automation"),
    "immich": ("Immich", "media"), "immich_server": ("Immich", "media"),
    "llama-server": ("llama.cpp", "ai"), "ollama": ("Ollama", "ai"), "comfyui": ("ComfyUI", "ai"), "mcpjungle": ("MCPJungle", "ai"),
    "cockpit-ws": ("Cockpit", "system"),
    "sshd": (None, "system"), "master": (None, "system"), "systemd-resolve": (None, "system"),
    "systemd": (None, "system"), "rpcbind": (None, "system"), "chronyd": (None, "system"),
}
# container-name/slug -> category for common community-scripts apps where the process is generic (node/python).
SLUG_CAT = {
    "sonarr": "media", "radarr": "media", "prowlarr": "media", "bazarr": "media", "lidarr": "media",
    "readarr": "media", "whisparr": "media", "mylar3": "media", "overseerr": "media", "jellyseerr": "media",
    "tdarr": "media", "tautulli": "media", "sabnzbd": "media", "qbittorrent": "media", "deluge": "media",
    "netbox": "network", "npm": "network", "nginxproxymanager": "network", "adguard": "network", "pihole": "network",
    "homepage": "dashboard", "dashy": "dashboard", "homarr": "dashboard", "heimdall": "dashboard",
    "paperless-ngx": "documents", "paperless": "documents", "privatebin": "documents",
    "nextcloud": "storage", "filebrowser": "storage", "immich": "media",
}
GENERIC = {"node", "python", "python3", "gunicorn", "uvicorn", "docker-proxy", "containerd",
           "dockerd", "java", "ruby", "php", "php-fpm", "beam.smp", "dotnet", "sh", "bash", "su", "deno", "bun"}
SKIP_PORTS = {22, 25, 53, 67, 68, 111, 123, 323, 3493, 5355}
TLS_PORTS = {443, 8443, 9443, 2087, 8006}
VM_SCAN_PORTS = [80, 443, 3000, 3001, 5000, 5001, 5601, 7000, 8000, 8006, 8080, 8081, 8086,
                 8096, 8123, 8443, 9000, 9001, 9090, 9443, 2283, 32400]
NODE_SCAN = None  # nodes get full ss, no scan

PROC_RE = re.compile(r'users:\(\("([^"]+)"')
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return {}


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")


def get_catalog():
    """Set of community-scripts ct/ slugs (544+). Cached; refreshed weekly. Network-failure tolerant."""
    c = load(CATALOG)
    if c.get("slugs") and (time.time() - c.get("fetchedAt", 0) < 7 * 86400):
        return set(c["slugs"])
    try:
        req = urllib.request.Request("https://api.github.com/repos/community-scripts/ProxmoxVE/contents/ct?ref=main",
                                     headers={"User-Agent": "ailab-probe", "Accept": "application/vnd.github+json"})
        data = json.load(urllib.request.urlopen(req, timeout=20))
        slugs = sorted({f["name"][:-3] for f in data if f.get("name", "").endswith(".sh")})
        if slugs:
            json.dump({"fetchedAt": int(time.time()), "slugs": slugs}, open(CATALOG, "w"))
            return set(slugs)
    except Exception:
        pass
    return set(c.get("slugs", []))


CATALOG_SLUGS = set()


def parse_ss(text):
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
        bind = "local" if addr in ("127.0.0.1", "[::1]") else "ext"
        out.append((port, bind, m.group(1) if m else ""))
    return out


def ssh_ss(ip, prefix=""):
    """Run ss on a host (prefix='' for the node itself, 'pct exec N -- ' for a CT)."""
    try:
        return subprocess.run(SSH + [f"root@{ip}", f"{prefix}ss -Hltnp 2>/dev/null"],
                              capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return ""


def collect_lxc(node, vmids):
    ip = NODE_IP.get(node)
    if not ip:
        return {}
    script = "; ".join(f'echo "##VMID {v}"; pct exec {v} -- ss -Hltnp 2>/dev/null' for v in vmids)
    try:
        txt = subprocess.run(SSH + [f"root@{ip}", script], capture_output=True, text=True, timeout=120).stdout
    except Exception:
        return {}
    res, cur, buf = {}, None, []
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


def http_probe(ip, port):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    ctx = ssl._create_unverified_context()
    for scheme in (("https", "http") if port in TLS_PORTS else ("http", "https")):
        op = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
        try:
            r = op.open(urllib.request.Request(f"{scheme}://{ip}:{port}/", headers={"User-Agent": "ailab-probe"}), timeout=3)
            body = r.read(4096).decode("utf-8", "ignore")
            tm = TITLE_RE.search(body)
            return {"proto": scheme, "status": r.status, "server": r.headers.get("Server", ""),
                    "title": (tm.group(1).strip()[:60] if tm else "")}
        except urllib.error.HTTPError as e:
            return {"proto": scheme, "status": e.code, "server": (e.headers.get("Server", "") if e.headers else ""), "title": ""}
        except Exception:
            continue
    return None


def identify(process, name, title, port):
    """-> (app, category, icon_slug, known_script)."""
    p = (process or "").lower()
    slug = slugify(name)
    known = bool(slug and slug in CATALOG_SLUGS)
    if p in PROC_MAP and PROC_MAP[p][0] is not None:
        app, cat = PROC_MAP[p]
    elif p in PROC_MAP:  # known system daemon, no app label
        app, cat = (name.title() if name else process), PROC_MAP[p][1]
    else:
        app = (name.replace("-", " ").title() if name else (title or process or "service"))
        cat = SLUG_CAT.get(slug, "app")
    # icon slug: prefer the container slug (matches dashboard-icons for most apps), else app-derived
    icon = slug or slugify(app)
    return app, cat, icon, known


def build():
    global CATALOG_SLUGS
    CATALOG_SLUGS = get_catalog()
    inv = load(INV)
    guests = [g for g in inv.get("entries", []) if g.get("status") == "running" and g.get("ip")]
    by_node, vms = {}, []
    for g in guests:
        (by_node.setdefault(g.get("node"), []).append(g) if g.get("type") == "lxc" else vms.append(g))

    # 1) LXC ground truth (parallel per node)
    lxc_ports = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(collect_lxc, node, [g["vmid"] for g in gl]): node for node, gl in by_node.items()}
        for f in futs:
            try:
                lxc_ports.update({(futs[f], v): pts for v, pts in f.result().items()})
            except Exception:
                pass

    # 2) PVE nodes themselves (parallel)
    node_ports = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(ssh_ss, ip): n for n, ip in NODE_IP.items()}
        for f in futs:
            try:
                node_ports[futs[f]] = parse_ss(f.result())
            except Exception:
                node_ports[futs[f]] = []

    # 3) candidate (host-descriptor, port, bind, proc, do_http)
    cand = []

    def add_ports(desc, ports):
        merged = {}
        for port, bind, proc in ports:
            if port not in merged or (bind == "ext" and merged[port][0] == "local"):
                merged[port] = (bind, proc)
        for port, (bind, proc) in merged.items():
            cand.append((desc, port, bind, proc, bind == "ext" and port not in SKIP_PORTS))

    for node, gl in by_node.items():
        for g in gl:
            desc = {"hostId": g.get("id") or f"pve-{g['vmid']}", "hostName": g.get("name"), "hostIp": g["ip"],
                    "vmid": g["vmid"], "guestType": "lxc", "node": node}
            add_ports(desc, lxc_ports.get((node, g["vmid"]), []))
    for g in vms:
        desc = {"hostId": g.get("id") or f"pve-{g['vmid']}", "hostName": g.get("name"), "hostIp": g["ip"],
                "vmid": g["vmid"], "guestType": "qemu", "node": g.get("node")}
        for port in VM_SCAN_PORTS:
            if tcp_open(g["ip"], port):
                cand.append((desc, port, "ext", "", True))
    for n, ip in NODE_IP.items():
        desc = {"hostId": f"node-{n}", "hostName": n, "hostIp": ip, "vmid": None, "guestType": "node", "node": n}
        add_ports(desc, node_ports.get(n, []))

    # 4) HTTP-probe ext ports in parallel
    def probe(item):
        desc, port, bind, proc, do = item
        return (desc, port, bind, proc, http_probe(desc["hostIp"], port) if do else None)

    results = list(ThreadPoolExecutor(max_workers=40).map(probe, [c for c in cand if c[4]]))
    results += [(c[0], c[1], c[2], c[3], None) for c in cand if not c[4]]

    # 5) group by host
    hosts = {}
    for desc, port, bind, proc, info in results:
        h = hosts.setdefault(desc["hostId"], {**desc, "services": []})
        if info:
            app, cat, icon, known = identify(proc, desc["hostName"], info.get("title", ""), port)
            h["services"].append({"port": port, "bind": bind, "process": proc, "proto": info["proto"],
                                  "status": info["status"], "title": info.get("title", ""),
                                  "app": app, "category": cat, "icon": icon, "knownScript": known,
                                  "url": f'{info["proto"]}://{desc["hostIp"]}:{port}'})
        else:
            app, cat, icon, known = identify(proc, desc["hostName"], "", port)
            h["services"].append({"port": port, "bind": bind, "process": proc, "proto": "tcp",
                                  "app": app if proc else None, "category": cat, "icon": icon if proc else None,
                                  "knownScript": known})
    for h in hosts.values():
        h["services"].sort(key=lambda x: x["port"])
    return {"generatedAt": int(time.time()), "catalogSize": len(CATALOG_SLUGS),
            "hosts": sorted(hosts.values(), key=lambda h: (h["guestType"], h.get("hostName") or ""))}


if __name__ == "__main__":
    data = build()
    tmp = OUT + ".tmp"
    open(tmp, "w").write(json.dumps(data, indent=1))
    os.replace(tmp, OUT)
    web = sum(1 for h in data["hosts"] for s in h["services"] if s["proto"] in ("http", "https"))
    print(f'{len(data["hosts"])} hosts, {web} web endpoints, catalog={data["catalogSize"]} -> {OUT}')
