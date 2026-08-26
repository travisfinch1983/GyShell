#!/bin/bash
# ProxLab Provider Installer: KoboldCpp
# Usage: PROXLAB_GPU_ARCHS="Volta" ./koboldcpp.sh [install|uninstall|status]
#
# When called by the orchestrator, base packages are already installed.
# When called standalone (legacy), handles its own prerequisite checks.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures (e.g. "Volta", "Ada Lovelace,Blackwell")
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/koboldcpp)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/koboldcpp}"
ARCHS="${PROXLAB_GPU_ARCHS:-}"

# ─── Architecture -> Build variant mapping ────────────────────────────────

get_build_variant() {
    # KoboldCpp Linux releases:
    #   koboldcpp-linux-x64         — standard CUDA 12 build (Ampere+)
    #   koboldcpp-linux-x64-oldpc   — CUDA 11 + AVX1 (Volta/Turing/older)
    #   koboldcpp-linux-x64-nocuda  — CPU only (no CUDA)
    if echo "$ARCHS" | grep -qiE "volta|turing"; then
        echo "koboldcpp-linux-x64-oldpc"
    else
        echo "koboldcpp-linux-x64"
    fi
}

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Ensure curl is available (may be standalone or orchestrated)
    if ! command -v curl &>/dev/null; then
        echo "Installing curl..."
        if command -v apt-get &>/dev/null; then
            apt-get update -qq && apt-get install -y -qq curl
        else
            echo "ERROR: curl not found and cannot install"
            echo "PROXLAB_STATUS=error"
            exit 1
        fi
    fi

    # Check if already installed
    if [ -x "$INSTALL_DIR/koboldcpp" ]; then
        local EXISTING_VER=""
        if [ -f "$INSTALL_DIR/.version" ]; then
            EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        fi
        echo "KoboldCpp already installed${EXISTING_VER:+: $EXISTING_VER}"
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=${EXISTING_VER:-unknown}"
        return 0
    fi

    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    local BUILD_VARIANT
    BUILD_VARIANT=$(get_build_variant)
    echo "Selected build: $BUILD_VARIANT (archs: ${ARCHS:-unknown})"

    # Get latest release info from GitHub API
    local RELEASE_JSON
    RELEASE_JSON=$(curl -sL "https://api.github.com/repos/LostRuins/koboldcpp/releases/latest")

    # Extract version tag
    local VER
    VER=$(echo "$RELEASE_JSON" | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)

    # Find the download URL for our build variant (exact filename match)
    local RELEASE_URL
    RELEASE_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url":\s*"\K[^"]+' | grep "/${BUILD_VARIANT}$" | head -1)

    if [ -z "$RELEASE_URL" ]; then
        echo "ERROR: Could not find KoboldCpp release for $BUILD_VARIANT"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "Downloading: $RELEASE_URL"
    curl -L --progress-bar -o koboldcpp "$RELEASE_URL"
    chmod +x koboldcpp

    # Save version for future idempotency checks
    echo "$VER" > "$INSTALL_DIR/.version"

    echo "KoboldCpp ${VER} installed to $INSTALL_DIR"

    # ─── Shared Folder Symlinks ──────────────────────────────────────────
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "llm-models" "$INSTALL_DIR/models"
    fi

    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed $INSTALL_DIR"
    fi
    echo "PROXLAB_STATUS=not_installed"
}

do_update() {
    if [ ! -x "$INSTALL_DIR/koboldcpp" ]; then
        echo "Not installed — run install first"
        echo "PROXLAB_STATUS=not_installed"
        return 1
    fi
    OLD_VER=$(cat "$INSTALL_DIR/.version" 2>/dev/null || echo "unknown")
    echo "Current version: $OLD_VER"
    VARIANT=$(get_build_variant)
    echo "Downloading latest $VARIANT..."
    LATEST_URL=$(curl -sL "https://api.github.com/repos/LostRuins/koboldcpp/releases/latest" | grep -oP "\"browser_download_url\": \"\K[^\"]*${VARIANT}[^\"]*" | head -1)
    if [ -z "$LATEST_URL" ]; then
        echo "ERROR: Could not find download URL"
        echo "PROXLAB_STATUS=error"
        return 1
    fi
    curl -L "$LATEST_URL" -o "$INSTALL_DIR/koboldcpp.new" && chmod +x "$INSTALL_DIR/koboldcpp.new"
    mv "$INSTALL_DIR/koboldcpp.new" "$INSTALL_DIR/koboldcpp"
    VER=$("$INSTALL_DIR/koboldcpp" --version 2>/dev/null | grep -oP '[\d.]+' | head -1 || echo "latest")
    echo "$VER" > "$INSTALL_DIR/.version"
    echo "Updated: $OLD_VER → $VER"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_check_update() {
    if [ ! -f "$INSTALL_DIR/.version" ]; then
        echo "PROXLAB_STATUS=not_installed"
        return
    fi
    CURRENT=$(cat "$INSTALL_DIR/.version")
    LATEST=$(curl -sL "https://api.github.com/repos/LostRuins/koboldcpp/releases/latest" | grep -oP '"tag_name": "\Kv?[^"]+' | head -1 | sed 's/^v//')
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$CURRENT"
    if [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ]; then
        echo "PROXLAB_UPDATE_AVAILABLE=$LATEST"
    fi
}

do_status() {
    if [ -x "$INSTALL_DIR/koboldcpp" ]; then
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
    install)      do_install      ;;
    uninstall)    do_uninstall    ;;
    status)       do_status       ;;
    update)       do_update       ;;
    check-update) do_check_update ;;
    *)
        echo "Usage: $0 {install|uninstall|status|update|check-update}"
        exit 1
        ;;
esac
