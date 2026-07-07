import os
import sys

from .server import run, run_http

def main() -> None:
    if "--http" in sys.argv or os.environ.get("MEMORY_MCP_HTTP_PORT"):
        run_http(int(os.environ.get("MEMORY_MCP_HTTP_PORT", "9847")))
    else:
        run()


if __name__ == "__main__":
    main()
