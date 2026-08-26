#!/bin/bash
# ProxLab Provider Installer: llama.cpp (llama-server)
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./llama-server.sh [install|uninstall|status|update|check-update]
#
# When called by the orchestrator, base packages are already installed.
# When called standalone, handles its own prerequisite checks.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures (e.g. "Ada Lovelace,Blackwell")
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA", "AMD")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/llama-server)
#   PROXLAB_LLAMA_BACKEND - Override backend: "cuda", "vulkan", "rocm", "cpu"
#
# Backend selection:
#   NVIDIA  → CUDA build from source (CUDA 12.9, last major with Volta libs)
#   AMD     → ROCm prebuilt if compatible, else Vulkan prebuilt
#   Other   → Vulkan prebuilt (universal)
#   CPU fb  → CPU-only prebuilt

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/llama-server}"
ARCHS="${PROXLAB_GPU_ARCHS:-}"
VENDOR="${PROXLAB_GPU_VENDOR:-NVIDIA}"
BACKEND_OVERRIDE="${PROXLAB_LLAMA_BACKEND:-}"

CUDA_HOME_DIR="/opt/cuda-12.9"
CUDA_MANIFEST="https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json"
REDIST_BASE="https://developer.download.nvidia.com/compute/cuda/redist"

# ─── Backend selection ────────────────────────────────────────────────────

get_backend() {
    if [ -n "$BACKEND_OVERRIDE" ]; then
        echo "$BACKEND_OVERRIDE"
        return
    fi
    case "$VENDOR" in
        NVIDIA)
            echo "cuda"
            ;;
        AMD)
            # ROCm prebuilts cover MI2/MI3 series. Otherwise fall back to Vulkan.
            if echo "$ARCHS" | grep -qiE "rocm|mi2|mi3|gfx9[0-9]"; then
                echo "rocm"
            else
                echo "vulkan"
            fi
            ;;
        *)
            echo "vulkan"
            ;;
    esac
}

# Map a GPU arch string (e.g. "Volta", "Ada Lovelace") to a CUDA sm_XX code.
archs_to_cuda_cmake() {
    local input="$1"
    local out=""
    local a
    IFS=',' read -ra arr <<< "$input"
    for a in "${arr[@]}"; do
        a=$(echo "$a" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
        case "$a" in
            volta|v100)             out+=";70" ;;
            turing|t4|rtx20*)       out+=";75" ;;
            ampere|a100|a40|a30)    out+=";80" ;;
            ampereconsumer|rtx30*)  out+=";86" ;;
            ada|adalovelace|rtx40*) out+=";89" ;;
            hopper|h100|h200)       out+=";90" ;;
            blackwell|b100|b200)    out+=";100" ;;
            blackwellconsumer|rtx50*) out+=";120" ;;
        esac
    done
    out="${out#;}"
    # Fallback to a broad set if nothing recognized
    if [ -z "$out" ]; then
        out="70;75;80;86;89;90"
    fi
    echo "$out"
}

# ─── CUDA Toolkit Install (redist tarballs, no apt) ──────────────────────

install_cuda_toolkit() {
    # Already installed? Still run the glibc 2.41 header patch idempotently
    # so existing installs get fixed up on re-run.
    if [ -x "$CUDA_HOME_DIR/bin/nvcc" ]; then
        echo "CUDA toolkit already present at $CUDA_HOME_DIR"
        patch_cuda_headers_for_glibc241
        return 0
    fi

    command -v jq >/dev/null || apt-get install -y -qq jq

    echo "Installing CUDA toolkit from NVIDIA redist tarballs..."
    local TMP
    TMP=$(mktemp -d)
    cd "$TMP"

    curl -sL -o manifest.json "$CUDA_MANIFEST"

    # Minimal components needed to build llama.cpp with CUDA.
    # cccl is a header-only deps pack (thrust, cub).
    local components=(
        cuda_nvcc
        cuda_cudart
        libcublas
        cuda_cccl
        cuda_nvrtc
        cuda_profiler_api
    )

    local c rel
    for c in "${components[@]}"; do
        rel=$(jq -r ".\"$c\".\"linux-x86_64\".relative_path // empty" manifest.json)
        if [ -z "$rel" ]; then
            echo "ERROR: CUDA component '$c' not in manifest"
            cd /
            rm -rf "$TMP"
            return 1
        fi
        echo "  Downloading $(basename "$rel")..."
        curl -sL -o "$(basename "$rel")" "$REDIST_BASE/$rel"
        tar -xJf "$(basename "$rel")"
    done

    # Each tarball extracts to <comp>-linux-x86_64-<ver>-archive/
    # Merge all component dirs into $CUDA_HOME_DIR
    mkdir -p "$CUDA_HOME_DIR"
    local d
    for d in */; do
        [ -d "$d" ] || continue
        # cp -rn avoids clobbering — all components have distinct content
        cp -rn "$d"* "$CUDA_HOME_DIR/" 2>/dev/null || true
    done

    cd /
    rm -rf "$TMP"

    if [ ! -x "$CUDA_HOME_DIR/bin/nvcc" ]; then
        echo "ERROR: CUDA install failed — nvcc missing"
        return 1
    fi

    # CUDA 12.9 redist tarballs place libs in lib/ (not lib64/ as older
    # redists did). nvcc/cmake look in lib64 first, so symlink for compat.
    if [ -d "$CUDA_HOME_DIR/lib" ] && [ ! -e "$CUDA_HOME_DIR/lib64" ]; then
        ln -s lib "$CUDA_HOME_DIR/lib64"
    fi

    local nvcc_ver
    nvcc_ver=$("$CUDA_HOME_DIR/bin/nvcc" --version | grep -oP 'release \K[\d.]+' || echo "?")
    echo "CUDA toolkit $nvcc_ver installed to $CUDA_HOME_DIR"

    patch_cuda_headers_for_glibc241
}

# ─── CUDA Header Patch for Debian 13 / glibc 2.41 ────────────────────────
# glibc 2.41 declares cospi/sinpi/cospif/sinpif with `noexcept(true)` in
# <bits/mathcalls.h>. CUDA's <crt/math_functions.h> declares the same four
# symbols without noexcept, causing "exception specification is incompatible
# with that of previous function" errors during nvcc device-compile.
#
# Patch the CUDA header in-place to append `noexcept(true)` to each of the
# four declarations. Idempotent: a marker comment at the top of the file
# skips re-patching.
patch_cuda_headers_for_glibc241() {
    local HDR="$CUDA_HOME_DIR/include/crt/math_functions.h"
    [ -f "$HDR" ] || return 0
    if head -5 "$HDR" | grep -q "PROXLAB_GLIBC241_PATCH"; then
        return 0
    fi
    echo "Patching CUDA math_functions.h for glibc 2.41 compat..."
    # Match declarations like:
    #   extern ... double  sinpi(double x);
    #   extern ... float   cospif(float x);
    # Append `noexcept(true)` before the trailing semicolon.
    sed -i -E \
        -e 's/(^extern __DEVICE_FUNCTIONS_DECL__[^;]*\b(sinpi|cospi|sinpif|cospif)\([^)]*\))[[:space:]]*;/\1 noexcept(true);/' \
        "$HDR"
    # Prepend a marker so we don't re-patch on re-install
    sed -i '1i/* PROXLAB_GLIBC241_PATCH: noexcept(true) appended to sinpi/cospi/sinpif/cospif */' "$HDR"
}

# ─── CUDA Build from Source ──────────────────────────────────────────────

build_cuda() {
    local VER="$1"
    local ARCHS_CMAKE
    ARCHS_CMAKE=$(archs_to_cuda_cmake "$ARCHS")

    echo "Installing build dependencies..."
    local MISSING=()
    command -v cmake   >/dev/null || MISSING+=(cmake)
    command -v git     >/dev/null || MISSING+=(git)
    command -v gcc     >/dev/null || MISSING+=(build-essential)
    command -v ccache  >/dev/null || MISSING+=(ccache)
    # CUDA 12.x officially supports gcc up to 13.x. On Debian 13 (default gcc-14)
    # we pin gcc-13 as the CUDA host compiler. The remaining glibc 2.41
    # cospi/sinpi noexcept-spec conflict is fixed via patch_cuda_headers_for_glibc241.
    [ -x /usr/bin/gcc-13 ] || MISSING+=(gcc-13 g++-13)
    if [ ${#MISSING[@]} -gt 0 ]; then
        apt-get update -qq
        apt-get install -y -qq "${MISSING[@]}"
    fi

    # Pick the host compiler for nvcc: prefer gcc-13, fall back to system gcc.
    local HOST_CC HOST_CXX
    if [ -x /usr/bin/gcc-13 ]; then
        HOST_CC=/usr/bin/gcc-13
        HOST_CXX=/usr/bin/g++-13
    else
        HOST_CC=/usr/bin/gcc
        HOST_CXX=/usr/bin/g++
    fi
    echo "Using $HOST_CC as CUDA host compiler"

    install_cuda_toolkit

    export PATH="$CUDA_HOME_DIR/bin:$PATH"
    export LD_LIBRARY_PATH="$CUDA_HOME_DIR/lib64:${LD_LIBRARY_PATH:-}"
    export CUDA_PATH="$CUDA_HOME_DIR"
    export CUDACXX="$CUDA_HOME_DIR/bin/nvcc"

    local SRC_DIR="$INSTALL_DIR/src"
    if [ -d "$SRC_DIR/.git" ]; then
        cd "$SRC_DIR"
        git fetch --tags --quiet origin
        git checkout "$VER" --quiet
    else
        echo "Cloning llama.cpp @ $VER..."
        git clone --depth 1 --branch "$VER" https://github.com/ggml-org/llama.cpp.git "$SRC_DIR"
    fi

    # Build fresh — remove any stale cmake cache from a previous failed run
    rm -rf "$SRC_DIR/build"

    echo "Building llama-server with CUDA (archs: $ARCHS_CMAKE) — this takes ~10-15 min..."
    cmake -S "$SRC_DIR" -B "$SRC_DIR/build" \
        -DGGML_CUDA=ON \
        -DCMAKE_CUDA_ARCHITECTURES="$ARCHS_CMAKE" \
        -DCMAKE_CUDA_HOST_COMPILER="$HOST_CXX" \
        -DCMAKE_C_COMPILER="$HOST_CC" \
        -DCMAKE_CXX_COMPILER="$HOST_CXX" \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLAMA_CURL=OFF \
        -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_BUILD_EXAMPLES=ON \
        -Wno-dev

    cmake --build "$SRC_DIR/build" --config Release -j"$(nproc)" --target llama-server

    # Copy the server binary plus every shared lib it produced
    cp "$SRC_DIR/build/bin/llama-server" "$INSTALL_DIR/"
    cp "$SRC_DIR/build/bin/"*.so* "$INSTALL_DIR/" 2>/dev/null || true

    # Bundle CUDA runtime + cuBLAS so we don't depend on system-wide /usr/local/cuda
    cp -Pf "$CUDA_HOME_DIR/lib64/libcudart.so"*   "$INSTALL_DIR/" 2>/dev/null || true
    cp -Pf "$CUDA_HOME_DIR/lib64/libcublas.so"*   "$INSTALL_DIR/" 2>/dev/null || true
    cp -Pf "$CUDA_HOME_DIR/lib64/libcublasLt.so"* "$INSTALL_DIR/" 2>/dev/null || true

    chmod +x "$INSTALL_DIR/llama-server"

    # Clean up build output to reclaim ~2GB (keep src for update)
    rm -rf "$SRC_DIR/build"

    echo "cuda:archs=$ARCHS_CMAKE" > "$INSTALL_DIR/.backend"
}

# ─── Prebuilt Asset Download (Vulkan, ROCm, CPU) ─────────────────────────

get_prebuilt_variant() {
    case "$1" in
        vulkan) echo "ubuntu-vulkan-x64" ;;
        rocm)   echo "ubuntu-rocm-7.2-x64" ;;
        cpu)    echo "ubuntu-x64" ;;
        *)      echo "ubuntu-vulkan-x64" ;;
    esac
}

install_prebuilt() {
    local BACKEND="$1"
    local VER="$2"
    local VARIANT
    VARIANT=$(get_prebuilt_variant "$BACKEND")

    # Backend-specific runtime deps
    if [ "$BACKEND" = "vulkan" ] && ! ldconfig -p | grep -q libvulkan.so; then
        echo "Installing Vulkan loader (libvulkan1)..."
        apt-get install -y -qq libvulkan1 mesa-vulkan-drivers || true
    fi

    local RELEASE_JSON
    RELEASE_JSON=$(curl -sL "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest")
    local RELEASE_URL
    RELEASE_URL=$(echo "$RELEASE_JSON" \
        | grep -oP '"browser_download_url":\s*"\K[^"]+' \
        | grep -E "llama-${VER}-bin-${VARIANT}\.(zip|tar\.gz)$" \
        | head -1)

    if [ -z "$RELEASE_URL" ]; then
        echo "ERROR: Could not find llama.cpp release asset for ${VARIANT}"
        echo "       (checked release ${VER})"
        return 1
    fi

    echo "Downloading: $RELEASE_URL"
    local ARCHIVE_NAME
    ARCHIVE_NAME=$(basename "$RELEASE_URL")
    cd "$INSTALL_DIR"
    curl -L --progress-bar -o "$ARCHIVE_NAME" "$RELEASE_URL"

    case "$ARCHIVE_NAME" in
        *.zip)           unzip -q "$ARCHIVE_NAME" ;;
        *.tar.gz|*.tgz)  tar -xzf "$ARCHIVE_NAME" ;;
        *)
            echo "ERROR: unknown archive format: $ARCHIVE_NAME"
            return 1
            ;;
    esac
    rm -f "$ARCHIVE_NAME"

    # Flatten whatever nested dir wraps llama-server
    local BIN_PATH
    BIN_PATH=$(find "$INSTALL_DIR" -maxdepth 4 -type f -name llama-server -print -quit || true)
    if [ -n "$BIN_PATH" ]; then
        local NESTED_DIR
        NESTED_DIR=$(dirname "$BIN_PATH")
        if [ "$NESTED_DIR" != "$INSTALL_DIR" ]; then
            mv "$NESTED_DIR"/* "$INSTALL_DIR/" 2>/dev/null || true
            find "$INSTALL_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null || true
        fi
    fi

    chmod +x "$INSTALL_DIR/llama-server" 2>/dev/null || true

    echo "$BACKEND" > "$INSTALL_DIR/.backend"
}

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Prereqs
    local MISSING=()
    command -v curl  >/dev/null || MISSING+=(curl)
    command -v unzip >/dev/null || MISSING+=(unzip)
    if [ ${#MISSING[@]} -gt 0 ]; then
        echo "Installing prerequisites: ${MISSING[*]}..."
        apt-get update -qq && apt-get install -y -qq "${MISSING[@]}"
    fi

    local BACKEND
    BACKEND=$(get_backend)

    # If already installed with the same backend, skip
    if [ -x "$INSTALL_DIR/llama-server" ] && [ -f "$INSTALL_DIR/.backend" ]; then
        local EXISTING_BACKEND EXISTING_VER=""
        EXISTING_BACKEND=$(cut -d: -f1 < "$INSTALL_DIR/.backend")
        [ -f "$INSTALL_DIR/.version" ] && EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if [ "$EXISTING_BACKEND" = "$BACKEND" ]; then
            echo "llama-server already installed (backend: $EXISTING_BACKEND${EXISTING_VER:+, version: $EXISTING_VER})"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=${EXISTING_VER:-unknown}"
            echo "PROXLAB_BACKEND=$EXISTING_BACKEND"
            return 0
        fi
        echo "Backend changed ($EXISTING_BACKEND -> $BACKEND). Reinstalling."
        rm -rf "$INSTALL_DIR"
    fi

    mkdir -p "$INSTALL_DIR"

    # Resolve upstream version (used by all backends)
    local RELEASE_JSON VER
    RELEASE_JSON=$(curl -sL "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest")
    VER=$(echo "$RELEASE_JSON" | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)

    echo "====================================================="
    echo "llama.cpp install"
    echo "  Backend: $BACKEND"
    echo "  Vendor:  $VENDOR"
    echo "  Archs:   ${ARCHS:-unknown}"
    echo "  Version: $VER"
    echo "====================================================="

    case "$BACKEND" in
        cuda)
            if ! build_cuda "$VER"; then
                echo "WARNING: CUDA build failed — falling back to Vulkan prebuilt"
                rm -rf "$INSTALL_DIR"
                mkdir -p "$INSTALL_DIR"
                install_prebuilt "vulkan" "$VER" || {
                    echo "PROXLAB_STATUS=error"; exit 1;
                }
                BACKEND="vulkan"
            fi
            ;;
        rocm|vulkan|cpu)
            install_prebuilt "$BACKEND" "$VER" || {
                echo "PROXLAB_STATUS=error"; exit 1;
            }
            ;;
        *)
            echo "ERROR: unknown backend '$BACKEND'"
            echo "PROXLAB_STATUS=error"
            exit 1
            ;;
    esac

    if [ ! -x "$INSTALL_DIR/llama-server" ]; then
        echo "ERROR: llama-server binary not found after install"
        ls "$INSTALL_DIR"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    echo "$VER" > "$INSTALL_DIR/.version"

    # Launch wrapper: resolves bundled .so's (including CUDA runtime if present)
    cat > "$INSTALL_DIR/run.sh" <<'EOF'
#!/bin/bash
# llama-server launch wrapper — resolves bundled shared libs
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="$DIR:${LD_LIBRARY_PATH:-}"
exec "$DIR/llama-server" "$@"
EOF
    chmod +x "$INSTALL_DIR/run.sh"

    # Point /opt/llama-server/models at the shared llm-models folder
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "llm-models" "$INSTALL_DIR/models"
    fi

    echo "llama-server $VER installed to $INSTALL_DIR (backend: $BACKEND)"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
    echo "PROXLAB_BACKEND=$BACKEND"
}

do_uninstall() {
    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed $INSTALL_DIR"
    fi
    # Leave $CUDA_HOME_DIR in place — it may be useful for other builds and
    # occupies ~1.5GB; users can `rm -rf /opt/cuda-12.*` manually if needed.
    echo "PROXLAB_STATUS=not_installed"
}

do_update() {
    if [ ! -x "$INSTALL_DIR/llama-server" ]; then
        echo "Not installed — run install first"
        echo "PROXLAB_STATUS=not_installed"
        return 1
    fi

    local OLD_VER BACKEND
    OLD_VER=$(cat "$INSTALL_DIR/.version" 2>/dev/null || echo "unknown")
    BACKEND=$(cut -d: -f1 < "$INSTALL_DIR/.backend" 2>/dev/null || echo "vulkan")
    echo "Current: $OLD_VER (backend: $BACKEND)"

    local VER RELEASE_JSON
    RELEASE_JSON=$(curl -sL "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest")
    VER=$(echo "$RELEASE_JSON" | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)

    if [ "$VER" = "$OLD_VER" ]; then
        echo "Already on latest ($VER)"
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$VER"
        echo "PROXLAB_BACKEND=$BACKEND"
        return 0
    fi

    if [ "$BACKEND" = "cuda" ]; then
        echo "Rebuilding CUDA variant for $VER..."
        build_cuda "$VER"
    else
        echo "Downloading prebuilt $BACKEND for $VER..."
        # Fresh extract into tmp, then atomically swap binary + libs
        local TMPDIR ARCHIVE_NAME VARIANT URL
        VARIANT=$(get_prebuilt_variant "$BACKEND")
        URL=$(echo "$RELEASE_JSON" \
            | grep -oP '"browser_download_url":\s*"\K[^"]+' \
            | grep -E "llama-${VER}-bin-${VARIANT}\.(zip|tar\.gz)$" \
            | head -1)
        if [ -z "$URL" ]; then
            echo "ERROR: No release asset for $VARIANT"
            echo "PROXLAB_STATUS=error"
            return 1
        fi
        TMPDIR=$(mktemp -d)
        cd "$TMPDIR"
        ARCHIVE_NAME=$(basename "$URL")
        curl -L --progress-bar -o "$ARCHIVE_NAME" "$URL"
        case "$ARCHIVE_NAME" in
            *.zip)      unzip -q "$ARCHIVE_NAME" ;;
            *.tar.gz)   tar -xzf "$ARCHIVE_NAME" ;;
        esac

        local SRC_BIN SRC_DIR
        SRC_BIN=$(find "$TMPDIR" -maxdepth 4 -type f -name llama-server -print -quit || true)
        if [ -z "$SRC_BIN" ]; then
            echo "ERROR: llama-server binary not found in update archive"
            echo "PROXLAB_STATUS=error"
            return 1
        fi
        SRC_DIR=$(dirname "$SRC_BIN")

        cp -f "$SRC_DIR/llama-server" "$INSTALL_DIR/llama-server.new"
        cp -f "$SRC_DIR"/*.so* "$INSTALL_DIR/" 2>/dev/null || true
        chmod +x "$INSTALL_DIR/llama-server.new"
        mv "$INSTALL_DIR/llama-server.new" "$INSTALL_DIR/llama-server"
        rm -rf "$TMPDIR"
    fi

    echo "$VER" > "$INSTALL_DIR/.version"
    echo "Updated: $OLD_VER -> $VER"
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
    echo "PROXLAB_BACKEND=$BACKEND"
}

do_check_update() {
    if [ ! -f "$INSTALL_DIR/.version" ]; then
        echo "PROXLAB_STATUS=not_installed"
        return
    fi
    local CURRENT LATEST BACKEND
    CURRENT=$(cat "$INSTALL_DIR/.version")
    BACKEND=$(cut -d: -f1 < "$INSTALL_DIR/.backend" 2>/dev/null || echo "?")
    LATEST=$(curl -sL "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" \
        | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)
    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$CURRENT"
    echo "PROXLAB_BACKEND=$BACKEND"
    if [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ]; then
        echo "PROXLAB_UPDATE_AVAILABLE=$LATEST"
    fi
}

do_status() {
    if [ -x "$INSTALL_DIR/llama-server" ]; then
        local VER="unknown" BACKEND="?"
        [ -f "$INSTALL_DIR/.version" ] && VER=$(cat "$INSTALL_DIR/.version")
        [ -f "$INSTALL_DIR/.backend" ] && BACKEND=$(cut -d: -f1 < "$INSTALL_DIR/.backend")
        echo "PROXLAB_STATUS=installed"
        echo "PROXLAB_VERSION=$VER"
        echo "PROXLAB_BACKEND=$BACKEND"
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
