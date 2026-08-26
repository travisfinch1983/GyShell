#!/bin/bash
# ProxLab Provider Installer: TabbyAPI
# Usage: PROXLAB_GPU_ARCHS="Ada Lovelace" ./tabbyapi.sh [install|uninstall|status]
#
# When called by the orchestrator, drivers + conda + PyTorch are already installed.
# TabbyAPI is an ExLlama-based API server — supports EXL2 and EXL3 quantized models.
# Git-clone based install with pip dependencies.
#
# Architecture notes:
#   - ExLlamaV2: Works on Volta+ (SM 7.0+), EXL2 quants
#   - ExLlamaV3: Requires Ampere+ (SM 8.0+), EXL3 quants, better quality-per-bit
#   - TabbyAPI auto-selects the right backend based on model format
#
# Environment variables (set by ProxLab installer service):
#   PROXLAB_GPU_ARCHS   - Comma-separated GPU architectures
#   PROXLAB_GPU_VENDOR  - Primary GPU vendor ("NVIDIA")
#   PROXLAB_INSTALL_DIR - Install directory (default: /opt/tabbyapi)

set -euo pipefail

ACTION="${1:-install}"
INSTALL_DIR="${PROXLAB_INSTALL_DIR:-/opt/tabbyapi}"
ARCHS="${PROXLAB_GPU_ARCHS:-}"
CONDA_ENV="${PROXLAB_CONDA_ENV:-tabbyapi}"

# Ensure conda is on PATH
export PATH="/opt/conda/bin:$PATH"

# ─── Actions ─────────────────────────────────────────────────────────────

do_install() {
    # Check if already installed
    if [ -f "$INSTALL_DIR/.version" ]; then
        EXISTING_VER=$(cat "$INSTALL_DIR/.version")
        if [ -f "$INSTALL_DIR/main.py" ]; then
            echo "TabbyAPI already installed: $EXISTING_VER"
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$EXISTING_VER"
            return 0
        fi
        echo "TabbyAPI version file exists but main.py missing — reinstalling"
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
        echo "WARNING: PyTorch CUDA not available — TabbyAPI may not work with GPU"
    fi

    echo "Installing TabbyAPI..."

    # Clone or update the repo
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo "Updating existing TabbyAPI repo..."
        git -C "$INSTALL_DIR" pull --ff-only 2>&1 || {
            echo "WARNING: git pull failed, continuing with existing version"
        }
    else
        # Clean slate if partial install exists
        rm -rf "$INSTALL_DIR"
        echo "Cloning TabbyAPI..."
        git clone https://github.com/theroyallab/tabbyAPI.git "$INSTALL_DIR" 2>&1
    fi

    # TabbyAPI uses pyproject.toml with GPU-specific extras:
    #   .[cu12] = NVIDIA CUDA 12 (PyTorch, ExLlamaV2/V3, Flash Attention)
    #   .[amd]  = AMD ROCm
    echo "Installing TabbyAPI dependencies (CUDA 12 extras)..."
    conda run -n "$CONDA_ENV" pip install -e "${INSTALL_DIR}[cu12]" 2>&1

    # Fix formatron pydantic v2 incompatibility.
    # formatron uses `from pydantic import typing` which was removed in pydantic v2.
    # Patch the two affected files to use standard library `import typing` instead.
    echo "Patching formatron for pydantic v2 compatibility..."
    FORMATRON_DIR=$(conda run -n "$CONDA_ENV" python3 -c "import formatron; import os; print(os.path.dirname(formatron.__file__))" 2>/dev/null || echo "")
    if [ -n "$FORMATRON_DIR" ] && [ -d "$FORMATRON_DIR/schemas" ]; then
        for f in "$FORMATRON_DIR/schemas/dict_inference.py" "$FORMATRON_DIR/schemas/json_schema.py"; do
            if [ -f "$f" ] && grep -q "from pydantic import typing" "$f"; then
                sed -i 's/from pydantic import typing/import typing/' "$f"
                echo "  Patched: $f"
            fi
        done
    else
        echo "WARNING: Could not locate formatron package — pydantic v2 patch not applied"
    fi

    # Install ExLlamaV3 separately if architecture supports it (Ampere+ / SM 8.0+)
    # The [cu12] extra may include V2 only — V3 needs explicit install
    if echo "$ARCHS" | grep -qiE "ampere|ada lovelace|blackwell|hopper"; then
        echo "Ampere+ detected — installing ExLlamaV3 for EXL3 support..."
        conda run -n "$CONDA_ENV" pip install exllamav3 2>&1 || {
            echo "WARNING: ExLlamaV3 install failed — EXL3 quants won't be available"
            echo "EXL2 quants via ExLlamaV2 will still work"
        }
    else
        echo "Pre-Ampere architecture — skipping ExLlamaV3 (EXL2 via ExLlamaV2 available)"
    fi

    # Get version from git tag or commit
    VER=$(git -C "$INSTALL_DIR" describe --tags --always 2>/dev/null || echo "unknown")

    if [ "$VER" = "unknown" ]; then
        VER=$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo "git-unknown")
    fi

    # Save version
    echo "$VER" > "$INSTALL_DIR/.version"

    # Create convenience launcher script
    cat > "$INSTALL_DIR/serve.sh" << 'SERVE_EOF'
#!/bin/bash
# TabbyAPI serve wrapper — usage: ./serve.sh [args...]
export PATH="/opt/conda/bin:$PATH"
cd "$(dirname "$0")"
exec conda run -n "${PROXLAB_CONDA_ENV:-tabbyapi}" \
    python3 main.py "$@"
SERVE_EOF
    chmod +x "$INSTALL_DIR/serve.sh"

    echo "TabbyAPI ${VER} installed to $INSTALL_DIR"

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
        conda run -n "$CONDA_ENV" pip uninstall -y exllamav2 exllamav3 2>/dev/null || true
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
        if [ -f "$INSTALL_DIR/main.py" ]; then
            echo "PROXLAB_STATUS=installed"
            echo "PROXLAB_VERSION=$VER"
        else
            echo "PROXLAB_STATUS=not_installed"
        fi
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
