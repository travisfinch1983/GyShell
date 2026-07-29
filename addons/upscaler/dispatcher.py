"""SSH-exec dispatch to a specific (agent_ip, cuda_index) GPU."""
import asyncio
import logging
import shlex
import time
from pathlib import Path
from typing import Optional

import httpx

from config import WORK_DIR
import db

log = logging.getLogger(__name__)


async def run(cmd: list[str], *, timeout: int = 3600) -> tuple[int, str, str]:
    """Async subprocess wrapper. Returns (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, "", f"timeout after {timeout}s"
    return proc.returncode, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


def _gpu_user() -> str:
    return db.get_setting("gpu_host_user", "root")


def _remote_workdir() -> str:
    return db.get_setting("gpu_host_workdir", "/tmp/companion-jobs")


def _script_path() -> str:
    return db.get_setting("gpu_host_script", "/opt/photo-upscale/upscale_pipeline.py")


def ssh_target_for(ip: str) -> str:
    return f"{_gpu_user()}@{ip}"


_SSH_KEEPALIVE_OPTS = [
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4",
    "-o", "BatchMode=yes",
]


def _ssh(target: str) -> list[str]:
    return ["ssh", *_SSH_KEEPALIVE_OPTS, target]


def _scp() -> list[str]:
    return ["scp", "-q", *_SSH_KEEPALIVE_OPTS]


async def ssh_ping(ip: str) -> bool:
    rc, _, _ = await run([*_ssh(ssh_target_for(ip)), "-o", "ConnectTimeout=5", "true"], timeout=10)
    return rc == 0


async def upscale_asset(asset_id: str, local_src: Path, model: str,
                        agent_ip: str, cuda_index: int) -> tuple[Optional[Path], str]:
    """Run upscale on the specified GPU. Returns (local_result, log_excerpt)."""
    target = ssh_target_for(agent_ip)
    remote_base = f"{_remote_workdir()}/{asset_id}"
    remote_in = f"{remote_base}/input"
    remote_out = f"{remote_base}/output"

    # 0. Pre-kill any orphan processes from a prior attempt for this asset.
    # `pkill -f` matches against the full cmdline; we look for the specific
    # asset_id in upscale_pipeline + inference_cli invocations.
    await run([*_ssh(target),
               f"pkill -9 -f {shlex.quote(remote_base)} 2>/dev/null; "
               f"pkill -9 -f {shlex.quote('seedvr2_' + asset_id[:8])} 2>/dev/null; true"],
              timeout=10)

    # 1. Stage input
    rc, _, err = await run(
        [*_ssh(target), f"mkdir -p {shlex.quote(remote_in)} {shlex.quote(remote_out)}"],
        timeout=30,
    )
    if rc != 0:
        return None, f"remote mkdir failed: {err}"
    rc, _, err = await run(
        [*_scp(), str(local_src), f"{target}:{remote_in}/"],
        timeout=120,
    )
    if rc != 0:
        return None, f"scp upload failed: {err}"

    # 2. Run upscale on the assigned GPU.
    # `exec` replaces the shell with the python proc so signals propagate cleanly.
    # `trap` ensures any descendant children die if the SSH session is killed.
    inner = (
        f"{shlex.quote(_script_path())} "
        f"--src {shlex.quote(remote_in)} "
        f"--dst {shlex.quote(remote_out)} "
        f"--model {shlex.quote(model)} "
        f"--cuda-device {shlex.quote(str(cuda_index))} "
        "--skip-mp-gate --quiet"
    )
    remote_cmd = (
        # Set process group, propagate SIGHUP/TERM, and exec the upscaler.
        f"set -m; "
        f"trap 'kill -TERM -$$ 2>/dev/null' HUP TERM INT; "
        f"exec {inner}"
    )
    t0 = time.time()
    # -tt forces TTY allocation: if the local ssh dies, sshd sees the TTY
    # close and sends SIGHUP to the remote process group, which kills our
    # python via the trap above.
    rc, out, err = await run([*_ssh(target), "-tt", remote_cmd], timeout=3600)
    elapsed = time.time() - t0
    log_excerpt = (out + "\n" + err)[-2000:]
    if rc != 0:
        await _cleanup_remote(target, remote_base)
        return None, f"upscale exit {rc} after {elapsed:.1f}s\n{log_excerpt}"

    # 3. Fetch result. Output lands in <remote_out>/<model>/<filename>
    local_dst_dir = WORK_DIR / asset_id / "output"
    local_dst_dir.mkdir(parents=True, exist_ok=True)
    rc, files_listing, err = await run(
        [*_ssh(target),
         f"ls {shlex.quote(remote_out)}/{shlex.quote(model)}/ 2>/dev/null || echo NONE"],
        timeout=30,
    )
    if "NONE" in files_listing or not files_listing.strip():
        await _cleanup_remote(target, remote_base)
        return None, f"no output produced after {elapsed:.1f}s\n{log_excerpt}"
    first_file = files_listing.strip().splitlines()[0].strip()
    if not first_file:
        await _cleanup_remote(target, remote_base)
        return None, f"empty output listing\n{log_excerpt}"
    local_result = local_dst_dir / first_file
    rc, _, err = await run(
        [*_scp(),
         f"{target}:{remote_out}/{shlex.quote(model)}/{shlex.quote(first_file)}",
         str(local_result)],
        timeout=300,
    )
    if rc != 0:
        await _cleanup_remote(target, remote_base)
        return None, f"scp download failed: {err}"

    await _cleanup_remote(target, remote_base)
    return local_result, f"ok in {elapsed:.1f}s"


async def _cleanup_remote(target: str, base: str) -> None:
    """Remove the remote work dir + kill any lingering procs that reference it."""
    try:
        await run([*_ssh(target),
                   f"pkill -9 -f {shlex.quote(base)} 2>/dev/null; "
                   f"rm -rf {shlex.quote(base)} 2>/dev/null; true"],
                  timeout=60)
    except Exception:
        pass


# ================================ batch mode =================================
# Run the upscale pipeline ONCE over a directory of N inputs. The pipeline loads
# the model once and loops, so a batch of N pays a single model load instead of
# N. Inputs are staged as <asset_id>.<ext>; outputs land at
# <remote_out>/<model>/<asset_id>.<OUTPUT_FORMAT>, giving a collision-free
# filename->asset_id map back (asset_ids are unique). Same per-image VRAM
# profile as the one-shot path, so it fits the 16 GB cards.

async def upscale_batch(batch_id: str, local_input_dir: Path, model: str,
                        agent_ip: str, cuda_index: int,
                        timeout: int = 7200) -> tuple[dict, bool, str]:
    """Returns (produced: {asset_id: local_path}, completed_ok, log_excerpt).
    `completed_ok` is True only if the pipeline exited 0 — callers use it to
    decide whether an un-produced asset genuinely failed (retry terminal) vs the
    batch was interrupted (re-queue for retry). Produced outputs are collected
    even on non-zero exit (partial progress is never thrown away)."""
    target = ssh_target_for(agent_ip)
    remote_base = f"{_remote_workdir()}/{batch_id}"
    remote_in = f"{remote_base}/input"
    remote_out = f"{remote_base}/output"

    async def _rm_remote():
        # Plain rm only — NO pkill (a `pkill -f <path>` would match the bash
        # running this very command, since its cmdline contains <path>, and
        # SIGKILL its own shell -> ssh exits 255 and the rm never runs).
        await run([*_ssh(target),
                   f"rm -rf {shlex.quote(remote_base)} 2>/dev/null; true"], timeout=60)

    # Best-effort orphan kill in a SEPARATE call whose result we ignore (if the
    # pattern self-matches the shell and it dies, that's fine — fresh batch_id
    # means there's nothing to kill anyway).
    await run([*_ssh(target),
               f"pkill -9 -f {shlex.quote(remote_base)} 2>/dev/null; true"], timeout=10)
    # Fresh remote dirs (checked).
    rc, _, err = await run([*_ssh(target),
               f"rm -rf {shlex.quote(remote_base)} 2>/dev/null; "
               f"mkdir -p {shlex.quote(remote_in)} {shlex.quote(remote_out)}"], timeout=30)
    if rc != 0:
        return {}, False, f"remote mkdir failed (rc={rc}): {err}"

    # Ship the input files into the (now-existing) remote_in dir. Copy explicit
    # files rather than `scp -r` a directory — modern scp (SFTP mode) won't
    # create a non-existent destination directory, but copying files into an
    # existing dir is reliable across scp versions.
    files = sorted(str(p) for p in Path(local_input_dir).iterdir() if p.is_file())
    if not files:
        await _rm_remote()
        return {}, False, "no input files staged locally"
    rc, _, err = await run(
        [*_scp(), *files, f"{target}:{remote_in}/"], timeout=900)
    if rc != 0:
        await _rm_remote()
        return {}, False, f"scp upload failed: {err}"

    inner = (
        f"{shlex.quote(_script_path())} "
        f"--src {shlex.quote(remote_in)} "
        f"--dst {shlex.quote(remote_out)} "
        f"--model {shlex.quote(model)} "
        f"--cuda-device {shlex.quote(str(cuda_index))} "
        "--skip-mp-gate --quiet"
    )
    remote_cmd = (
        f"set -m; trap 'kill -TERM -$$ 2>/dev/null' HUP TERM INT; exec {inner}")
    rc, out, err = await run([*_ssh(target), "-tt", remote_cmd], timeout=timeout)
    log_excerpt = (out + "\n" + err)[-3000:]
    completed_ok = rc == 0

    # Collect whatever was produced (even on failure -> partial progress).
    produced: dict = {}
    local_out = WORK_DIR / batch_id / "output"
    local_out.mkdir(parents=True, exist_ok=True)
    _, listing, _ = await run(
        [*_ssh(target),
         f"ls {shlex.quote(remote_out)}/{shlex.quote(model)}/ 2>/dev/null || true"],
        timeout=30)
    for fn in listing.split():
        stem = Path(fn).stem          # == asset_id (inputs were named <asset_id>.<ext>)
        lp = local_out / fn
        rc3, _, _ = await run(
            [*_scp(),
             f"{target}:{remote_out}/{shlex.quote(model)}/{shlex.quote(fn)}", str(lp)],
            timeout=300)
        if rc3 == 0:
            produced[stem] = lp

    await _rm_remote()
    return produced, completed_ok, log_excerpt


# ============================ resident-server mode ============================
# A long-lived upscale_server.py holds the SeedVR2 model in VRAM and processes
# one image per HTTP request, so we stop paying the per-image process/CUDA/model
# startup tax. One server per (agent_ip, cuda_index); the companion reaches it
# directly over the LAN at agent_ip:(port_base+cuda_index). The server self-exits
# after an idle period, freeing VRAM back to other GPU users.

def use_resident_server() -> bool:
    return db.get_setting("use_resident_server", "0") == "1"


def _server_port(cuda_index: int) -> int:
    base = int(db.get_setting("upscale_server_port_base", "9700") or 9700)
    return base + int(cuda_index)


def _server_python() -> str:
    return db.get_setting("gpu_host_python", "/opt/photo-upscale/.venv/bin/python")


def _server_script() -> str:
    return db.get_setting("gpu_host_server_script",
                          "/opt/photo-upscale/upscale_server.py")


def _server_idle_timeout() -> int:
    return int(db.get_setting("upscale_server_idle_timeout", "180") or 180)


async def _server_health(agent_ip: str, port: int, timeout: float = 4.0) -> Optional[dict]:
    """GET /health. Returns the parsed dict or None if unreachable."""
    url = f"http://{agent_ip}:{port}/health"
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.get(url)
            if r.status_code == 200:
                return r.json()
    except Exception:
        return None
    return None


async def ensure_server(agent_ip: str, cuda_index: int, model: str,
                        launch_wait: int = 90) -> tuple[bool, str]:
    """Make sure a healthy server for `model` is listening on this GPU's port.
    Launches one over SSH if absent; relaunches if a server is up for a
    different model. Returns (ok, detail)."""
    port = _server_port(cuda_index)
    target = ssh_target_for(agent_ip)

    health = await _server_health(agent_ip, port)
    if health and health.get("model") == model:
        return True, "already running"
    if health and health.get("model") != model:
        # wrong model resident -> ask it to exit, then relaunch
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                await c.post(f"http://{agent_ip}:{port}/shutdown", json={})
        except Exception:
            pass
        # also hard-kill anything bound to that port's script on this device
        await run([*_ssh(target),
                   f"pkill -9 -f {shlex.quote('--port ' + str(port))} 2>/dev/null; true"],
                  timeout=15)
        await asyncio.sleep(2)

    # Launch (nohup so it survives the SSH session; setsid for its own pgroup).
    launch = (
        f"cd {shlex.quote(str(Path(_server_script()).parent))} && "
        f"setsid nohup {shlex.quote(_server_python())} {shlex.quote(_server_script())} "
        f"--cuda-device {shlex.quote(str(cuda_index))} "
        f"--port {port} "
        f"--model {shlex.quote(model)} "
        f"--idle-timeout {_server_idle_timeout()} "
        f"> /tmp/upscale_server_{port}.log 2>&1 < /dev/null & echo launched"
    )
    rc, out, err = await run([*_ssh(target), launch], timeout=30)
    if rc != 0:
        return False, f"server launch ssh failed rc={rc}: {err[-300:]}"

    # Poll /health until the model finishes importing/listening.
    deadline = time.time() + launch_wait
    while time.time() < deadline:
        h = await _server_health(agent_ip, port, timeout=3.0)
        if h and h.get("model") == model:
            return True, "launched"
        await asyncio.sleep(2)
    # grab a log tail to explain the failure
    _, ltail, _ = await run(
        [*_ssh(target), f"tail -n 20 /tmp/upscale_server_{port}.log 2>/dev/null"],
        timeout=15)
    return False, f"server did not become healthy in {launch_wait}s\n{ltail[-600:]}"


async def upscale_asset_server(asset_id: str, local_src: Path, model: str,
                               agent_ip: str, cuda_index: int) -> tuple[Optional[Path], str]:
    """Resident-server variant of upscale_asset: stage input, POST to the warm
    server, fetch the result. Same return contract as upscale_asset."""
    target = ssh_target_for(agent_ip)
    port = _server_port(cuda_index)
    remote_base = f"{_remote_workdir()}/{asset_id}"
    remote_in = f"{remote_base}/input"
    remote_out = f"{remote_base}/output"

    ok, detail = await ensure_server(agent_ip, cuda_index, model)
    if not ok:
        return None, f"ensure_server failed: {detail}"

    # 1. Stage input on the GPU host.
    rc, _, err = await run(
        [*_ssh(target), f"mkdir -p {shlex.quote(remote_in)} {shlex.quote(remote_out)}"],
        timeout=30)
    if rc != 0:
        return None, f"remote mkdir failed: {err}"
    rc, _, err = await run([*_scp(), str(local_src), f"{target}:{remote_in}/"], timeout=120)
    if rc != 0:
        return None, f"scp upload failed: {err}"
    remote_infile = f"{remote_in}/{local_src.name}"

    # 2. Ask the resident server to process it.
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=3600) as c:
            r = await c.post(f"http://{agent_ip}:{port}/upscale",
                             json={"in_path": remote_infile, "out_dir": remote_out})
        payload = r.json()
    except Exception as e:
        await _cleanup_remote(target, remote_base)
        return None, f"server request failed: {e}"
    elapsed = time.time() - t0
    if not payload.get("ok"):
        await _cleanup_remote(target, remote_base)
        return None, (f"server error after {elapsed:.1f}s: "
                      f"{payload.get('error')}\n{payload.get('traceback','')[-800:]}")

    out_file = payload.get("out_file")
    if not out_file:
        await _cleanup_remote(target, remote_base)
        return None, f"server returned no out_file after {elapsed:.1f}s"

    # 3. Fetch the produced image.
    local_dst_dir = WORK_DIR / asset_id / "output"
    local_dst_dir.mkdir(parents=True, exist_ok=True)
    local_result = local_dst_dir / Path(out_file).name
    rc, _, err = await run(
        [*_scp(), f"{target}:{shlex.quote(out_file)}", str(local_result)], timeout=300)
    if rc != 0:
        await _cleanup_remote(target, remote_base)
        return None, f"scp download failed: {err}"

    await _cleanup_remote(target, remote_base)
    srv_elapsed = payload.get("elapsed_sec", elapsed)
    return local_result, f"ok in {srv_elapsed:.1f}s (warm server)"
