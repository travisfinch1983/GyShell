#!/usr/bin/env python3
"""Autodiscover inference /metrics endpoints — PORT-AGNOSTIC + SERVICE-AGNOSTIC.

Enumerates the LIVE listening ports on each host via a forced-command 'ss' SSH key
(no hardcoded port list), probes every port for /metrics, and classifies the backend
by METRIC CONTENT (not port) so the same port serving llama.cpp today and vLLM tomorrow
is always identified correctly. Model name via /v1/models. Writes Prometheus file-SD,
reloads on change. Add a host to HOSTS or a backend prefix to BACKENDS to extend."""
import json, os, sys, re, subprocess, urllib.request, pwd, grp
from concurrent.futures import ThreadPoolExecutor

HOSTS = {
    "px-gpu":  {"ip": "10.0.0.235", "ct": "177"},   # 8x V100
    "px-epyc": {"ip": "10.0.0.234", "ct": "176"},   # 4090 + 5060Ti
    "px-nas":  {"ip": "10.0.0.48",  "ct": "198"},   # RTX 5060 shared with Frigate (reranker primary)
}
KEY = "/opt/inference-sd/monitor_key"
OUT = "/etc/prometheus/targets/inference.json"
RELOAD = "http://localhost:9090/-/reload"
TIMEOUT = 1.5
SKIP_PORTS = {22, 25, 9100, 9835}   # ssh, smtp, node_exporter, gpu_exporter
# backend detection by /metrics content (port-agnostic); extend as needed
BACKENDS = [("llamacpp:", "llamacpp"), ("vllm:", "vllm"), ("sglang:", "sglang"),
            ("tgi_", "tgi"), ("text_generation_", "tgi"), ("exllama", "exllamav2"),
            ("trtllm", "tensorrt-llm"), ("lmdeploy", "lmdeploy")]
# a generic inference server (has /v1/models) is accepted even with an unknown metric
# namespace, as long as /metrics isn't purely infra (node/process/go/promhttp).
INFRA_RE = re.compile(r"(?m)^(?!#)(?!process_|python_|go_|promhttp_|node_)[A-Za-z]\w*[ {]")

def enum_ports(ip):
    try:
        out = subprocess.run(
            ["ssh", "-i", KEY, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
             "-o", "ConnectTimeout=8", f"root@{ip}", "x"],
            capture_output=True, text=True, timeout=15).stdout
    except Exception as e:
        print(f"  port-enum failed for {ip}: {e}", file=sys.stderr)
        return []
    ports = set()
    for line in out.splitlines():
        f = line.split()
        if len(f) < 4:
            continue
        addr = f[3]
        if addr.startswith("127.0.0.1:") or addr.startswith("[::1]:"):
            continue
        p = addr.rsplit(":", 1)[-1]
        if p.isdigit() and int(p) not in SKIP_PORTS:
            ports.add(int(p))
    return sorted(ports)

def get(ip, port, path):
    try:
        with urllib.request.urlopen(f"http://{ip}:{port}{path}", timeout=TIMEOUT) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        return None

def classify(ip, port):
    m = get(ip, port, "/metrics")
    if not m:
        return None
    backend = next((b for pref, b in BACKENDS if pref in m), None)
    model, has_models = "unknown", False
    mv = get(ip, port, "/v1/models")
    if mv:
        try:
            model = json.loads(mv)["data"][0]["id"]
            has_models = True
        except Exception:
            pass
    if not backend:
        if has_models and INFRA_RE.search(m):
            backend = "openai-generic"
        else:
            return None
    return {"backend": backend, "model": model[:64], "port": port, "ip": ip}

def main():
    groups = []
    for host, info in sorted(HOSTS.items()):
        ports = enum_ports(info["ip"])
        with ThreadPoolExecutor(max_workers=16) as ex:
            for c in ex.map(lambda p: classify(info["ip"], p), ports):
                if c:
                    groups.append({"targets": [f"{c['ip']}:{c['port']}"],
                                   "labels": {"backend": c["backend"], "host": host,
                                              "ct": info["ct"], "model": c["model"]}})
    new = json.dumps(groups, indent=2, sort_keys=True)
    old = open(OUT).read() if os.path.exists(OUT) else ""
    if new.strip() == old.strip():
        print(f"no change ({len(groups)} targets)")
        return
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        f.write(new)
    os.replace(tmp, OUT)
    try:
        os.chown(OUT, pwd.getpwnam("prometheus").pw_uid, grp.getgrnam("prometheus").gr_gid)
    except Exception:
        pass
    try:
        urllib.request.urlopen(urllib.request.Request(RELOAD, method="POST"), timeout=5)
        rl = "reloaded"
    except Exception as e:
        rl = f"reload FAILED: {e}"
    print(f"updated: {len(groups)} targets ({rl})")
    for g in groups:
        print(f"  {g['labels']['model']:42} {g['targets'][0]:20} [{g['labels']['backend']}]")

if __name__ == "__main__":
    main()
