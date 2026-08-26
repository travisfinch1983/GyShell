#!/bin/bash
# ProxLab Provider Installer: Ollama
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./ollama.sh [install|uninstall|status]
#
# Uses Ollama's official install method. Since v0.16+, releases are .tar.zst
# and bundle CUDA libraries (~1.7GB). Requires zstd for extraction.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/ollama)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/ollama}"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Ensure curl is available
    if ! command -v curl &>/dev/null; then
        echo "Installing curl..."
        apt-get update -qq && apt-get install -y -qq curl
    fi

    # Check if already installed
    if [ -x "$INSTALL_DIR/bin/ollama" ] || [ -x "$INSTALL_DIR/ollama" ]; then
        local EXISTING_VER=""
        if [ -f "$INSTALL_DIR/.version" ]; then
            EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        fi
        echo "Ollama already installed${EXISTING_VER:+: $EXISTING_VER}"
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=${EXISTING_VER:-unknown}"
        return 0
    fi

    # Get latest version from GitHub API
    local VER
    VER=$(curl -sL "https://api.github.com/repos/ollama/ollama/releases/latest" \
        | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)

    if [ -z "$VER" ]; then
        echo "ERROR: Could not determine latest Ollama version"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Installing Ollama ${VER}..."

    # Ollama's official install.sh handles:
    # - .tar.zst extraction (requires zstd)
    # - Binary + CUDA libraries placement
    # - systemd service setup
    # - GPU detection

    # Ensure zstd is available (needed for .tar.zst since v0.16+)
    if ! command -v zstd &>/dev/null; then
        echo "Installing zstd (needed for Ollama .tar.zst package)..."
        apt-get update -qq && apt-get install -y -qq zstd
    fi

    mkdir -p "$INSTALL_DIR"

    # Download and extract the tarball
    local DOWNLOAD_URL="https://ollama.com/download/ollama-linux-amd64.tar.zst"
    echo "Downloading from $DOWNLOAD_URL..."
    curl -fL --progress-bar "$DOWNLOAD_URL" | zstd -d | tar -xf - -C "$INSTALL_DIR"

    # The tarball extracts with bin/ollama and lib/ollama/ structure
    local OLLAMA_BIN=""
    if [ -x "$INSTALL_DIR/bin/ollama" ]; then
        OLLAMA_BIN="$INSTALL_DIR/bin/ollama"
    elif [ -x "$INSTALL_DIR/ollama" ]; then
        OLLAMA_BIN="$INSTALL_DIR/ollama"
    fi

    if [ -z "$OLLAMA_BIN" ]; then
        echo "ERROR: ollama binary not found after extraction"
        echo "Contents of $INSTALL_DIR:"
        ls -la "$INSTALL_DIR/" 2>/dev/null || true
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Create symlink for PATH access
    ln -sf "$OLLAMA_BIN" /usr/local/bin/ollama

    # Save version for idempotency
    echo "$VER" > "$INSTALL_DIR/.version"

    # Verify
    if ollama --version &>/dev/null; then
        echo "Ollama ${VER} installed to $INSTALL_DIR"
    else
        echo "Ollama ${VER} installed to $INSTALL_DIR (binary present)"
    fi
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed $INSTALL_DIR"
    fi
    # Remove symlink
    rm -f /usr/local/bin/ollama
    echo "PROXLAB_STATUS=not_installed"
}

do_status() {
    if [ -x "$INSTALL_DIR/bin/ollama" ] || [ -x "$INSTALL_DIR/ollama" ]; then
        local VER="unknown"
        if [ -f "$INSTALL_DIR/.version" ]; then
            VER=$(cat "$INSTALL_DIR/.version")
        fi
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$VER"
    else
        echo "PROXLAB_STATUS=not_installed"
    fi
}

# ─── Dispatch ────────────────────────────────────────────────────────────

case "$ACTION" in
    install)   do_install   ;;
    uninstall) do_uninstall ;;
    status)    do_status    ;;
    *)
        echo "Usage: $0 {install|uninstall|status}"
        exit 1
        ;;
esac
