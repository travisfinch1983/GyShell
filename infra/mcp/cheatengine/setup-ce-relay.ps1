# Cheat Engine MCP relay setup v2 (run in an ADMIN PowerShell on the PC that runs Cheat Engine; safe to re-run).
# Installs miscusi-peek/cheatengine-mcp-bridge (pinned commit) plus a patched TCP relay that needs no pywin32,
# and locks the relay port down so ONLY the homelab forwarder can reach it: claude1 -> CT110 (socat) ->
# tailnet 100.64.0.3 -> this PC. The relay has no auth of its own: whoever connects can drive Cheat Engine
# (including its Lua engine), hence the firewall rules.
$ErrorActionPreference = 'Stop'
$Commit  = '6bd7ce9'
$Dir     = 'C:\cheatengine-mcp-bridge'
$Port    = 9876
$Allowed = '100.64.0.3'                                         # CT110 "headscale" tailnet IP
$Blocked = @('0.0.0.0-100.64.0.2', '100.64.0.4-255.255.255.255')  # everything else

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an Administrator PowerShell (needed for the firewall rules).'
}

# 1. Python (Windows PowerShell 5.1 compatible: no ?? operator)
$py = Get-Command py -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
if ($py -and $py.Source -like '*WindowsApps*') { $py = $null }   # the Store stub, not a real Python
if (-not $py) {
    Write-Host 'Installing Python 3.12 via winget...'
    winget install -e --id Python.Python.3.12 --scope machine --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $py = Get-Command py -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python }
}
Write-Host "Using Python: $($py.Source)"

# 2. Bridge files at the pinned commit (only if missing)
if (-not (Test-Path "$Dir\MCP_Server\ce_mcp_bridge.lua")) {
    $zip = Join-Path $env:TEMP 'ce-mcp-bridge.zip'
    Invoke-WebRequest "https://github.com/miscusi-peek/cheatengine-mcp-bridge/archive/$Commit.zip" -OutFile $zip
    $tmp = Join-Path $env:TEMP 'ce-mcp-bridge-x'; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $zip $tmp
    New-Item -ItemType Directory -Force $Dir | Out-Null
    Copy-Item (Join-Path (Get-ChildItem $tmp | Select-Object -First 1).FullName '*') $Dir -Recurse -Force
}

# 3. Patched relay (plain-Python named pipe I/O; upstream's needs pywin32)
$relay = @'
#!/usr/bin/env python3
r"""TCP-to-named-pipe relay for the Cheat Engine MCP bridge (no pywin32).

Patched from upstream miscusi-peek/cheatengine-mcp-bridge @6bd7ce9 MCP_Server/ce_tcp_relay.py:
the named pipe is opened with plain Python file I/O instead of pywin32 (win32file), which
failed to import on Travis's PC. Frame format is unchanged: 4-byte little-endian length + JSON.

Run on Windows while ce_mcp_bridge.lua is loaded in Cheat Engine. The relay has no auth:
restrict who can reach the port with Windows Firewall.
"""

from __future__ import annotations

import argparse
import socket
import socketserver
import struct
import sys
import time
from typing import Optional

PIPE_NAME = r"\\.\pipe\CE_MCP_Bridge_v99"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9876
MAX_FRAME_SIZE_BYTES = 32 * 1024 * 1024


def log(msg: str) -> None:
    print(f"[relay {time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


def read_socket_exact(sock: socket.socket, size: int) -> Optional[bytes]:
    """Read exactly size bytes, returning None on clean peer disconnect."""
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            if remaining == size:
                return None
            raise ConnectionError("TCP client disconnected mid-frame.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_pipe_exact(pipe, size: int) -> bytes:
    """Read exactly size bytes from the named pipe (raw reads may return short)."""
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        chunk = pipe.read(remaining)
        if not chunk:
            raise ConnectionError("Cheat Engine pipe closed mid-frame.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def validate_frame_size(size: int, direction: str) -> None:
    if size > MAX_FRAME_SIZE_BYTES:
        raise ConnectionError(
            f"{direction} frame too large: {size} bytes (max {MAX_FRAME_SIZE_BYTES} bytes).")


def open_pipe(attempts: int = 20):
    """Open the CE pipe; retry while it's busy or the bridge is still starting."""
    last: Optional[OSError] = None
    for _ in range(attempts):
        try:
            return open(PIPE_NAME, "r+b", buffering=0)
        except OSError as exc:
            last = exc
            time.sleep(0.25)
    raise ConnectionError(
        f"Could not open {PIPE_NAME}: {last}. Is ce_mcp_bridge.lua loaded in Cheat Engine?")


class RelayHandler(socketserver.BaseRequestHandler):
    """Relay one TCP client connection to one persistent CE pipe connection."""

    def setup(self) -> None:
        self.pipe = None
        self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def handle(self) -> None:
        peer = f"{self.client_address[0]}:{self.client_address[1]}"
        log(f"TCP client connected: {peer}")
        try:
            self.pipe = open_pipe()
            while True:
                req_header = read_socket_exact(self.request, 4)
                if req_header is None:
                    break
                req_len = struct.unpack("<I", req_header)[0]
                validate_frame_size(req_len, "request")
                req_body = read_socket_exact(self.request, req_len)
                if req_body is None:
                    raise ConnectionError("TCP client disconnected before request body.")

                self.pipe.write(req_header + req_body)

                resp_header = read_pipe_exact(self.pipe, 4)
                resp_len = struct.unpack("<I", resp_header)[0]
                validate_frame_size(resp_len, "response")
                resp_body = read_pipe_exact(self.pipe, resp_len)
                self.request.sendall(resp_header + resp_body)
        except (ConnectionError, OSError) as exc:
            log(f"Connection ended for {peer}: {exc}")
        finally:
            if self.pipe is not None:
                try:
                    self.pipe.close()
                except OSError:
                    pass
                self.pipe = None
            log(f"TCP client disconnected: {peer}")


class RelayServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    global PIPE_NAME
    parser = argparse.ArgumentParser(description="Relay TCP frames to the Cheat Engine MCP named pipe.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--pipe", default=PIPE_NAME)
    args = parser.parse_args()
    PIPE_NAME = args.pipe

    if sys.platform != "win32":
        log("This relay must run on Windows (it opens a Windows named pipe).")
        return 1

    log(f"Listening on {args.host}:{args.port}; forwarding to {PIPE_NAME}")
    with RelayServer((args.host, args.port), RelayHandler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            log("Stopping.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'@
Set-Content -Path "$Dir\MCP_Server\ce_tcp_relay.py" -Value $relay -Encoding UTF8

# 4. Firewall: allow the forwarder, BLOCK everyone else (block rules beat any broad "allow python" rule)
Get-NetFirewallRule -DisplayName 'CE MCP relay*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'CE MCP relay - allow homelab forwarder' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $Allowed -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'CE MCP relay - block others' -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $Blocked -Action Block -Profile Any | Out-Null

# 5. Launcher
$bat = @"
@echo off
title CE MCP relay (port $Port, homelab forwarder only)
"$($py.Source)" "$Dir\MCP_Server\ce_tcp_relay.py" --host 0.0.0.0 --port $Port
pause
"@
Set-Content -Path "$Dir\start-relay.bat" -Value $bat -Encoding ASCII
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\CE MCP relay.lnk")
$lnk.TargetPath = "$Dir\start-relay.bat"; $lnk.Save()

Write-Host ""
Write-Host "Done. Each session:"
Write-Host "  1. Cheat Engine: File > Execute Script > $Dir\MCP_Server\ce_mcp_bridge.lua  (look for 'MCP Server Listening')"
Write-Host "  2. Double-click 'CE MCP relay' on the desktop; it should say 'Listening on 0.0.0.0:$Port'. Leave it open."
