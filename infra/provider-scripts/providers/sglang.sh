#!/bin/bash
# ProxLab Provider Installer: SGLang
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./sglang.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
# SGLang uses RadixAttention for KV cache prefix reuse — major win for multi-turn.
# ~29% faster than vLLM on many benchmarks.
#
# Known issues:
#   - SM89 (Ada Lovelace, e.g. RTX 4090): sgl_kernel >= 0.3.13 only ships SM90/SM100
#     binaries. sgl_kernel 0.3.12 has universal binary but ABI-incompatible with
#     PyTorch 2.9+. Workaround: --disable-cuda-graph, but sgl_kernel import still fails.
#   - Separate conda env recommended to avoid flashinfer version conflicts with vLLM.
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/sglang)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/sglang}"
ARCHS="${PROXLAB_GPU_ARCHS:-}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-sglang}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if conda run -n "$CONDA_ENV" python3 -c "import sglang; print(sglang.__version__)" &>/dev/null; then
            echo "SGLang already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "SGLang version file exists but import failed — reinstalling"
    fi

    # Verify prereqs
    if ! command -v conda &>/dev/null; then
        echo "ERROR: conda not found — install-conda.sh must run first"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Check PyTorch + CUDA
    CUDA_AVAIL=$(conda run -n "$CONDA_ENV" python3 -c "import torch; print(torch.cuda.is_available())" 2>/dev/null || echo "False")
    if [ "$CUDA_AVAIL" != "True" ]; then
        echo "WARNING: PyTorch CUDA not available — SGLang may not work with GPU"
    fi

    mkdir -p "$INSTALL_DIR"

    # outlines_core (dep of outlines, dep of sglang) requires a Rust compiler
    # to build from source when no prebuilt wheel is available (e.g. Python 3.13).
    # It also needs OpenSSL dev headers + pkg-config for the openssl-sys crate.
    # libnuma-dev is required by sgl_kernel at runtime.
    RUST_DEPS=()
    command -v rustc &>/dev/null || RUST_DEPS+=(rustc cargo)
    command -v pkg-config &>/dev/null || RUST_DEPS+=(pkg-config)
    dpkg -s libssl-dev &>/dev/null 2>&1 || RUST_DEPS+=(libssl-dev)
    dpkg -s libnuma-dev &>/dev/null 2>&1 || RUST_DEPS+=(libnuma-dev)
    if [ ${#RUST_DEPS[@]} -gt 0 ]; then
        echo "Installing build deps for outlines_core + sgl_kernel: ${RUST_DEPS[*]}"
        export DEBIAN_FRONTEND=noninteractive
        apt-get install -y -qq "${RUST_DEPS[@]}" 2>&1
    fi

    echo "Installing SGLang..."

    # Install sglang (no extras — current versions don't define [all] or [srt])
    conda run -n "$CONDA_ENV" pip install sglang 2>&1

    # Get installed version
    VER=$(conda run -n "$CONDA_ENV" python3 -c "import sglang; print(sglang.__version__)" 2>/dev/null || echo "unknown")

    if [ "$VER" = "unknown" ]; then
        echo "ERROR: SGLang installation failed — import not working"
        echo "PROXLAB_STATUS=error"
        exit 1
    fi

    # Save version
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher script
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# SGLang serve wrapper — usage: ./serve.sh <model_path> [args...]
export PATH="/opt/conda/bin:$PATH"
MODEL="${1:?Usage: serve.sh <model_path> [extra sglang args...]}"
shift
exec conda run -n "${PROXLAB_CONDA_ENV:-sglang}" \
    python3 -m sglang.launch_server --model-path "$MODEL" "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "SGLang ${VER} installed to $INSTALL_DIR"

    # ─── Shared Folder Symlinks ──────────────────────────────────────────
    if [ -f "/tmp/proxlab-install/providers/prereqs/shared-symlinks.sh" ]; then
        source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
        proxlab_symlink "llm-models" "$INSTALL_DIR/models"
    fi

    echo "PROXLAB_STATUS=installed"
    echo "PROXLAB_VERSION=$VER"
}

do_uninstall() {
    if command -v conda &>/dev/null && [ "$CONDA_ENV" != "base" ]; then
        echo "Removing conda environment: $CONDA_ENV"
        conda env remove -n "$CONDA_ENV" -y 2>/dev/null || true
    elif command -v conda &>/dev/null; then
        conda run -n "$CONDA_ENV" pip uninstall -y sglang 2>/dev/null || true
    fi

    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        echo "Removed $INSTALL_DIR"
    fi
    echo "PROXLAB_STATUS=not_installed"
}

do_status() {
    if [ -f "$INSTALL_DIR/.version" ]; then
        VER=$(cat "$INSTALL_DIR/.version")
        if command -v conda &>/dev/null; then
            ACTUAL=$(conda run -n "$CONDA_ENV" python3 -c "import sglang; print(sglang.__version__)" 2>/dev/null || echo "")
            if [ -n "$ACTUAL" ]; then
                echo "PROXLAB_STATUS=installed"
                echo "PROXLAB_VERSION=$ACTUAL"
                return
            fi
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
