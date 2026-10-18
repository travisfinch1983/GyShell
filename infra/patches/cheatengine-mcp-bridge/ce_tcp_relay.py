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
import json
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
        f"Could not open {PIPE_NAME}: {last}. Either ce_mcp_bridge.lua isn't loaded in Cheat Engine, "
        "or another connection still holds the pipe (the bridge serves one client at a time).")


def exchange(pipe, req_header: bytes, req_body: bytes):
    """One request/response round trip on the pipe. Header and body are written as two
    writes, exactly like upstream, in case the pipe is in message mode."""
    method = "?"
    try:
        method = json.loads(req_body).get("method", "?")
    except ValueError:
        pass
    t0 = time.time()
    pipe.write(req_header)
    pipe.write(req_body)
    log(f"-> {method} ({len(req_body)} bytes) sent to Cheat Engine, waiting for reply...")
    resp_header = read_pipe_exact(pipe, 4)
    resp_len = struct.unpack("<I", resp_header)[0]
    validate_frame_size(resp_len, "response")
    resp_body = read_pipe_exact(pipe, resp_len)
    log(f"<- {method} reply {resp_len} bytes in {time.time() - t0:.2f}s")
    return resp_header, resp_body


def selftest() -> int:
    """Talk to Cheat Engine locally (no network): open the pipe and send one ping."""
    try:
        import win32file  # noqa: F401
        log("pywin32 import: OK (not needed by this relay)")
    except Exception as exc:
        log(f"pywin32 import fails (not needed by this relay): {exc!r}")
    log(f"Opening {PIPE_NAME} ...")
    pipe = open_pipe()
    log("Pipe opened. Sending ping (if this hangs, Cheat Engine isn't answering: check its Lua window).")
    body = json.dumps({"jsonrpc": "2.0", "method": "ping", "params": {}, "id": 1}).encode()
    _, resp = exchange(pipe, struct.pack("<I", len(body)), body)
    log(f"Reply: {resp[:300]!r}")
    pipe.close()
    return 0


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
            log(f"{peer}: Cheat Engine pipe opened")
            while True:
                req_header = read_socket_exact(self.request, 4)
                if req_header is None:
                    break
                req_len = struct.unpack("<I", req_header)[0]
                validate_frame_size(req_len, "request")
                req_body = read_socket_exact(self.request, req_len)
                if req_body is None:
                    raise ConnectionError("TCP client disconnected before request body.")

                resp_header, resp_body = exchange(self.pipe, req_header, req_body)
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
    parser.add_argument("--selftest", action="store_true", help="ping Cheat Engine locally and exit")
    args = parser.parse_args()
    PIPE_NAME = args.pipe

    if sys.platform != "win32":
        log("This relay must run on Windows (it opens a Windows named pipe).")
        return 1

    if args.selftest:
        return selftest()

    log(f"Listening on {args.host}:{args.port}; forwarding to {PIPE_NAME}")
    with RelayServer((args.host, args.port), RelayHandler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            log("Stopping.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
