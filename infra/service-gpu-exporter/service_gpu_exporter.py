#!/usr/bin/env python3
"""
service-gpu-exporter — per-SERVICE GPU usage for Prometheus (Travis's ask:
replace the nvtop-cmdline attribution behind the AI Service card sparklines).

Runs on the GPU PVE hosts (px-gpu, px-epyc) alongside the nvidia_smi exporter.
Deliberately HOST-side: nvidia-smi's compute-apps PIDs are host PIDs, so
/proc/<pid>/... resolves directly — running inside a container would hit the
host-PID-vs-container-PID namespace mismatch and the join would silently fail.

Metrics (keyed by the LIVE listening port — never a hardcoded one; the AI-Lab
backend joins port -> serviceId via the active-services registry, which is
rebuilt on every launch, so dynamic ports survive reboots):

  service_gpu_vram_bytes{port,gpu_uuid,cmd}   per-process VRAM, summed per (port,gpu)
  service_gpu_util_ratio{port,gpu_uuid,cmd}   per-process SM% (nvidia-smi pmon), 0..1
  service_gpu_exporter_scrape_duration_seconds
  service_gpu_exporter_up

Port resolution per GPU pid, all discovered live from /proc:
  1. The pid's OWN listening sockets: socket inodes from /proc/<pid>/fd matched
     against st=0A rows of /proc/<pid>/net/{tcp,tcp6} (the pid's own netns, so
     container services report the port as registered).
  2. Ports in the kernel's ephemeral range (/proc/sys/net/ipv4/ip_local_port_range)
     are treated as internal RPC (vLLM EngineCore's ZMQ mesh) — not service ports.
  3. No service port on the pid itself -> walk ancestors (<=4 hops, stopping at
     init/lxc-start): vLLM's API port lives on the `vllm serve` parent, not the
     EngineCore GPU process. Verified live on px-gpu: EngineCore 296706 ->
     parent 295783 LISTEN 5003.
  4. Still nothing -> port="none" (visible but unjoinable; e.g. sunshine).

An idle service simply has no GPU process => no series => the backend reads 0,
which fixes the old bug where idle/co-located services read the whole-GPU total.

Zero dependencies (stdlib http.server); scrape does one nvidia-smi query pass +
one pmon one-shot + cheap /proc reads (~100-200ms).
"""
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 9840
ANCESTOR_HOPS = 4


def run(cmd: list[str], timeout: float = 10.0) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


# Ephemeral floor: the Linux-default/IANA dynamic-range boundary. Deliberately
# NOT read from ip_local_port_range — PVE hosts widen it to 1024-65535 (live
# finding: px-gpu), which would classify every service port as ephemeral. This
# is a port-CLASS convention, not a hardcoded service port; service_ports()
# still falls back to unfiltered ports so a service genuinely listening above
# the floor is emitted rather than lost.
EPH_FLOOR = 32768


def listen_ports(pid: int) -> list[int]:
    """The pid's own LISTEN ports, via fd socket inodes x its netns tcp tables."""
    fd_dir = Path(f"/proc/{pid}/fd")
    inodes: set[str] = set()
    try:
        for fd in fd_dir.iterdir():
            try:
                target = fd.readlink().as_posix() if hasattr(fd, "readlink") else str(fd.resolve())
            except OSError:
                continue
            if target.startswith("socket:["):
                inodes.add(target[8:-1])
    except OSError:
        return []
    if not inodes:
        return []
    ports: set[int] = set()
    for table in ("tcp", "tcp6"):
        try:
            lines = Path(f"/proc/{pid}/net/{table}").read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 10 or parts[3] != "0A":
                continue
            if parts[9] in inodes:
                ports.add(int(parts[1].rsplit(":", 1)[1], 16))
    return sorted(ports)


def parent_of(pid: int) -> int:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("PPid:"):
                return int(line.split()[1])
    except OSError:
        pass
    return 0


def comm_of(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return "?"


def service_ports(pid: int) -> list[int]:
    """LISTEN ports for the pid: own below-floor ports first; ancestors' if it
    has none (vLLM's API port lives on the `vllm serve` parent — stop the walk
    at init/lxc-start, a container's init listens on 22, not ours); finally the
    pid's own ports unfiltered (a service really listening above the floor)."""
    own_all = listen_ports(pid)
    own = [p for p in own_all if p < EPH_FLOOR]
    if own:
        return own
    cur = pid
    for _ in range(ANCESTOR_HOPS):
        cur = parent_of(cur)
        if cur <= 1:
            break
        comm = comm_of(cur)
        if comm in ("init", "systemd", "lxc-start"):
            break
        anc = [p for p in listen_ports(cur) if p < EPH_FLOOR]
        if anc:
            return anc
    return own_all


def esc(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "")


def collect() -> str:
    t0 = time.monotonic()
    lines: list[str] = [
        "# HELP service_gpu_vram_bytes Per-service GPU VRAM (per-process, summed per port+gpu). Joined to services by live listening port.",
        "# TYPE service_gpu_vram_bytes gauge",
        "# HELP service_gpu_util_ratio Per-service GPU SM utilization (nvidia-smi pmon, per-process), 0..1.",
        "# TYPE service_gpu_util_ratio gauge",
    ]
    ok = 1

    # gpu index -> uuid (pmon reports the index, compute-apps the uuid)
    idx2uuid: dict[str, str] = {}
    for row in run(["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"]).splitlines():
        parts = [p.strip() for p in row.split(",")]
        if len(parts) == 2:
            idx2uuid[parts[0]] = parts[1]

    # pid -> vram per gpu (MiB)
    apps: list[tuple[int, float, str]] = []
    out = run(["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory,gpu_uuid", "--format=csv,noheader,nounits"])
    if not out.strip() and not idx2uuid:
        ok = 0
    for row in out.splitlines():
        parts = [p.strip() for p in row.split(",")]
        if len(parts) == 3:
            try:
                apps.append((int(parts[0]), float(parts[1]), parts[2]))
            except ValueError:
                continue

    # pid+gpu -> sm% (pmon one-shot; '-' for idle/unsupported)
    sm: dict[tuple[int, str], float] = {}
    for row in run(["nvidia-smi", "pmon", "-c", "1", "-s", "u"]).splitlines():
        if row.startswith("#"):
            continue
        parts = row.split()
        if len(parts) < 4:
            continue
        try:
            uuid = idx2uuid.get(parts[0], "")
            pid = int(parts[1])
            util = float(parts[3]) if parts[3] != "-" else 0.0
        except ValueError:
            continue
        if uuid:
            sm[(pid, uuid)] = sm.get((pid, uuid), 0.0) + util

    # resolve ports once per pid, then aggregate per (port, gpu)
    pids = sorted({pid for pid, _, _ in apps})
    ports_of: dict[int, list[int]] = {pid: service_ports(pid) for pid in pids}
    comm: dict[int, str] = {pid: comm_of(pid) for pid in pids}

    vram: dict[tuple[str, str, str], float] = {}
    util: dict[tuple[str, str, str], float] = {}
    for pid, mib, uuid in apps:
        ports = ports_of.get(pid) or []
        keys = [(str(p), uuid, comm[pid]) for p in ports] or [("none", uuid, comm[pid])]
        for key in keys:
            vram[key] = vram.get(key, 0.0) + mib * 1024 * 1024
            util[key] = util.get(key, 0.0) + sm.get((pid, uuid), 0.0) / 100.0

    for (port, uuid, cmd), v in sorted(vram.items()):
        labels = f'port="{esc(port)}",gpu_uuid="{esc(uuid)}",cmd="{esc(cmd)}"'
        lines.append(f"service_gpu_vram_bytes{{{labels}}} {v:.0f}")
        lines.append(f"service_gpu_util_ratio{{{labels}}} {util[(port, uuid, cmd)]:.4f}")

    lines.append("# TYPE service_gpu_exporter_scrape_duration_seconds gauge")
    lines.append(f"service_gpu_exporter_scrape_duration_seconds {time.monotonic() - t0:.3f}")
    lines.append("# TYPE service_gpu_exporter_up gauge")
    lines.append(f"service_gpu_exporter_up {ok}")
    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") not in ("", "/metrics"):
            self.send_response(404)
            self.end_headers()
            return
        try:
            body = collect().encode()
        except Exception as e:  # never take the scrape target down
            body = f"service_gpu_exporter_up 0\n# error: {e}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # quiet
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
