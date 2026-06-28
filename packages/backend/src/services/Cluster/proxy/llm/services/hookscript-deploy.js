/**
 * Hookscript Deploy Service
 * Manages ProxLab hookscripts on PVE shared storage.
 * Deploys master hookscript, GPU sub-script, shared folder hook, and per-container vars.
 */

import { mergeWithDefaults, getDefaultSharedFolders } from './shared-folders.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __hsDirname = dirname(fileURLToPath(import.meta.url));
const sharedFoldersPath = join(process.env.AILAB_PROXY_DATA_DIR || join(__hsDirname, '..', '..', 'data'), 'shared-folders.json');
const cacheManifestPath = join(process.env.AILAB_PROXY_DATA_DIR || join(__hsDirname, '..', '..', 'data'), 'model-cache.json');
const aiConfigPath = join(process.env.AILAB_PROXY_DATA_DIR || join(__hsDirname, '..', '..', 'data'), 'ai-config.json');

function loadSharedFoldersSync() {
  try {
    if (existsSync(sharedFoldersPath)) {
      return mergeWithDefaults(JSON.parse(readFileSync(sharedFoldersPath, 'utf-8')));
    }
  } catch {}
  return getDefaultSharedFolders();
}

function loadCacheManifestSync() {
  try {
    if (existsSync(cacheManifestPath)) return JSON.parse(readFileSync(cacheManifestPath, 'utf-8'));
  } catch {}
  return { entries: [] };
}

function loadAiConfigSync() {
  try {
    if (existsSync(aiConfigPath)) return JSON.parse(readFileSync(aiConfigPath, 'utf-8'));
  } catch {}
  return { pools: {}, agents: {}, version: 1 };
}

export class HookscriptDeploy {
  constructor(sshService, pveApi, gpuMonitor, config) {
    this.sshService = sshService;
    this.pveApi = pveApi;
    this.gpuMonitor = gpuMonitor;
    this.staticDeployed = false;

    // Storage paths from config (with sensible defaults)
    const storage = config?.storage || {};
    this.snippetsBase = storage.snippetsPath || '/mnt/pve/local/snippets';

    // Derive the PVE storage reference for hookscript registration
    // e.g. "/mnt/pve/px-data/snippets" → "px-data:snippets/proxlab-master.sh"
    const match = this.snippetsBase.match(/\/mnt\/pve\/([^/]+)\/snippets/);
    const storageName = match ? match[1] : (storage.name || 'local');
    this.hookscriptRef = `${storageName}:snippets/proxlab-master.sh`;
  }

  // --- Static file templates ---

  generateMasterScript() {
    return `#!/bin/bash
# ProxLab Master Hookscript - auto-deployed, do not edit manually
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
VMID="$1"
PHASE="$2"

VARS_FILE="\${SCRIPT_DIR}/proxlab-vars/\${VMID}.sh"
HOOKS_DIR="\${SCRIPT_DIR}/proxlab-hooks"

# Source common utilities
[ -f "\${HOOKS_DIR}/common.sh" ] && source "\${HOOKS_DIR}/common.sh"

# Source per-container vars (auto-exports all PROXLAB_* variables)
if [ -f "$VARS_FILE" ]; then
    set -a
    source "$VARS_FILE"
    set +a
fi

case "$PHASE" in
    pre-start)
        [ "\${PROXLAB_GPU_COUNT:-0}" -gt 0 ] && "\${HOOKS_DIR}/gpu-hook.sh" "$VMID" "$PHASE"
        [ "\${PROXLAB_SHARED_COUNT:-0}" -gt 0 ] && "\${HOOKS_DIR}/shared-hook.sh" "$VMID" "$PHASE"
        ;;
    post-start)
        [ "\${PROXLAB_CACHE_COUNT:-0}" -gt 0 ] && "\${HOOKS_DIR}/cache-hook.sh" "$VMID" "$PHASE"
        ;;
    pre-stop)
        ;;
    post-stop)
        ;;
esac

exit 0
`;
  }

  generateCommonScript() {
    return `#!/bin/bash
# ProxLab common hookscript utilities - auto-deployed, do not edit manually

# Color codes for debug output
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
NC='\\033[0m'

proxlab_log() {
    echo -e "\${BLUE}[ProxLab]\${NC} $*"
}

proxlab_ok() {
    echo -e "\${GREEN}[ProxLab]\${NC} $*"
}

proxlab_warn() {
    echo -e "\${YELLOW}[ProxLab]\${NC} $*"
}

proxlab_err() {
    echo -e "\${RED}[ProxLab]\${NC} $*"
}
`;
  }

  generateGpuHookScript() {
    return `#!/bin/bash
# ProxLab GPU Passthrough Hook - auto-deployed, do not edit manually
# Reads PROXLAB_* environment variables (exported by master hookscript).
# Resolves device nodes dynamically at boot time.

VMID="$1"
PHASE="$2"
CONF="/etc/pve/lxc/\${VMID}.conf"
MARKER_START="# proxlab-gpu-start"

# Source common utilities (logging functions)
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
[ -f "\${SCRIPT_DIR}/common.sh" ] && source "\${SCRIPT_DIR}/common.sh"
# Fallback if common.sh not found
type proxlab_log &>/dev/null || proxlab_log() { echo "[ProxLab] $*"; }
type proxlab_ok &>/dev/null || proxlab_ok() { echo "[ProxLab] $*"; }
type proxlab_warn &>/dev/null || proxlab_warn() { echo "[ProxLab] $*"; }
type proxlab_err &>/dev/null || proxlab_err() { echo "[ProxLab] $*"; }
MARKER_END="# proxlab-gpu-end"

# Detect GIDs (not hardcoded)
VIDEO_GID=$(getent group video | cut -d: -f3)
RENDER_GID=$(getent group render | cut -d: -f3)
VIDEO_GID=\${VIDEO_GID:-44}
RENDER_GID=\${RENDER_GID:-104}

clean_conf() {
    # 1. Remove marker block if present
    if grep -q "$MARKER_START" "$CONF" 2>/dev/null; then
        sed -i "/^$MARKER_START$/,/^$MARKER_END$/d" "$CONF"
    fi

    # 2. Remove any stray GPU-related entries that may exist outside markers
    #    Old-style: lxc.mount.entry for dev/dri/* and dev/nvidia*
    sed -i '/^lxc\\.mount\\.entry:.*dev\\/dri/d' "$CONF"
    sed -i '/^lxc\\.mount\\.entry:.*dev\\/nvidia/d' "$CONF"
    #    All cgroup2 device allows (nvidia-uvm major is dynamic, can be 503-510+)
    sed -i '/^lxc\\.cgroup2\\.devices\\.allow:/d' "$CONF"
    #    Old-style: lxc.mount.entry for dev/nvidia-caps/*
    sed -i '/^lxc\\.mount\\.entry:.*dev\\/nvidia-caps/d' "$CONF"
    #    New-style: dev0: /dev/dri/*, dev0: /dev/nvidia*
    sed -i '/^dev[0-9]*:.*\\/dev\\/dri\\//d' "$CONF"
    sed -i '/^dev[0-9]*:.*\\/dev\\/nvidia/d' "$CONF"

    proxlab_log "CT $VMID: cleaned previous GPU entries"
}

resolve_dri_devices() {
    local PCI_BUS="$1"
    local SHORT_BUS="\${PCI_BUS#0000:}"
    local CARD_NUM=""
    local RENDER_NUM=""

    # Find card/renderD numbers from by-path symlinks
    for link in /dev/dri/by-path/*; do
        [ -L "$link" ] || continue
        local linkname=$(basename "$link")
        # Match PCI bus in the by-path name (case-insensitive)
        if echo "$linkname" | grep -qi "$SHORT_BUS"; then
            local target=$(readlink -f "$link")
            local devname=$(basename "$target")
            case "$devname" in
                card[0-9]*)
                    CARD_NUM="\${devname#card}"
                    ;;
                renderD[0-9]*)
                    RENDER_NUM="\${devname#renderD}"
                    ;;
            esac
        fi
    done

    echo "$CARD_NUM $RENDER_NUM"
}

resolve_nvidia_minor() {
    local UUID="$1"
    if [ -z "$UUID" ]; then
        echo ""
        return
    fi
    local MINOR=$(nvidia-smi -q -i "$UUID" 2>/dev/null | grep "Minor Number" | awk '{print $NF}')
    echo "$MINOR"
}

get_cgroup_devnums() {
    local DEV_PATH="$1"
    if [ ! -e "$DEV_PATH" ]; then
        echo ""
        return
    fi
    local MAJOR=$(stat -c "0x%t" "$DEV_PATH" 2>/dev/null)
    local MINOR=$(stat -c "0x%T" "$DEV_PATH" 2>/dev/null)
    if [ -n "$MAJOR" ] && [ -n "$MINOR" ]; then
        printf "%d %d" "$((MAJOR))" "$((MINOR))"
    fi
}

do_pre_start() {
    local GPU_COUNT=\${PROXLAB_GPU_COUNT:-0}
    local MOUNT_STYLE=\${PROXLAB_MOUNT_STYLE:-new}

    if [ "$GPU_COUNT" -eq 0 ]; then
        return 0
    fi

    proxlab_log "CT $VMID: configuring $GPU_COUNT GPU(s) using $MOUNT_STYLE mount style"

    # Clean any stale entries first
    clean_conf

    local CONF_LINES=""
    local HAS_NVIDIA=0
    local DEV_INDEX=0

    # For old-style mounts, ensure /dev/dri exists as tmpfs inside the container
    # before any bind-mounts of card/renderD devices are applied
    if [ "$MOUNT_STYLE" = "old" ]; then
        CONF_LINES+="\nlxc.mount.entry: tmpfs dev/dri tmpfs rw,nosuid,nodev,mode=755,create=dir 0 0"
    fi

    for i in $(seq 1 $GPU_COUNT); do
        local PCI_VAR="PROXLAB_GPU_\${i}_PCI"
        local VENDOR_VAR="PROXLAB_GPU_\${i}_VENDOR"
        local UUID_VAR="PROXLAB_GPU_\${i}_UUID"
        local NAME_VAR="PROXLAB_GPU_\${i}_NAME"

        local PCI_BUS=\${!PCI_VAR}
        local VENDOR=\${!VENDOR_VAR}
        local UUID=\${!UUID_VAR}
        local GPU_NAME=\${!NAME_VAR}

        if [ -z "$PCI_BUS" ]; then
            proxlab_warn "CT $VMID: GPU $i has no PCI bus ID, skipping"
            continue
        fi

        proxlab_log "CT $VMID: GPU $i = $GPU_NAME ($PCI_BUS, $VENDOR)"

        # Resolve DRI device numbers
        local DRI_INFO=$(resolve_dri_devices "$PCI_BUS")
        local CARD_NUM=$(echo "$DRI_INFO" | awk '{print $1}')
        local RENDER_NUM=$(echo "$DRI_INFO" | awk '{print $2}')

        # DRI entries — only if DRI card resolved (non-fatal if missing)
        if [ -n "$CARD_NUM" ]; then
            proxlab_ok "CT $VMID:   card$CARD_NUM, renderD$RENDER_NUM"

            if [ "$MOUNT_STYLE" = "new" ]; then
                CONF_LINES+="\ndev\${DEV_INDEX}: /dev/dri/card\${CARD_NUM},gid=\${VIDEO_GID}"
                DEV_INDEX=$((DEV_INDEX + 1))
                if [ -n "$RENDER_NUM" ]; then
                    CONF_LINES+="\ndev\${DEV_INDEX}: /dev/dri/renderD\${RENDER_NUM},gid=\${RENDER_GID}"
                    DEV_INDEX=$((DEV_INDEX + 1))
                fi
            else
                local CARD_DEVNUMS=$(get_cgroup_devnums "/dev/dri/card\${CARD_NUM}")
                local RENDER_DEVNUMS=$(get_cgroup_devnums "/dev/dri/renderD\${RENDER_NUM}")

                CONF_LINES+="\nlxc.mount.entry: /dev/dri/card\${CARD_NUM} dev/dri/card\${CARD_NUM} none bind,optional,create=file 0 0"
                if [ -n "$RENDER_NUM" ]; then
                    CONF_LINES+="\nlxc.mount.entry: /dev/dri/renderD\${RENDER_NUM} dev/dri/renderD\${RENDER_NUM} none bind,optional,create=file 0 0"
                fi
                if [ -n "$CARD_DEVNUMS" ]; then
                    CONF_LINES+="\nlxc.cgroup2.devices.allow: c $(echo $CARD_DEVNUMS | awk '{print $1}'):$(echo $CARD_DEVNUMS | awk '{print $2}') rwm"
                fi
                if [ -n "$RENDER_DEVNUMS" ]; then
                    CONF_LINES+="\nlxc.cgroup2.devices.allow: c $(echo $RENDER_DEVNUMS | awk '{print $1}'):$(echo $RENDER_DEVNUMS | awk '{print $2}') rwm"
                fi
            fi
        else
            proxlab_warn "CT $VMID: could not resolve DRI card for $PCI_BUS — DRI entries skipped"
        fi

        # NVIDIA-specific: resolve nvidia device minor (independent of DRI resolution)
        if echo "$VENDOR" | grep -qi "nvidia"; then
            HAS_NVIDIA=1
            local NV_MINOR=$(resolve_nvidia_minor "$UUID")
            if [ -n "$NV_MINOR" ]; then
                proxlab_ok "CT $VMID:   nvidia\${NV_MINOR}"
                if [ "$MOUNT_STYLE" = "new" ]; then
                    CONF_LINES+="\ndev\${DEV_INDEX}: /dev/nvidia\${NV_MINOR}"
                    DEV_INDEX=$((DEV_INDEX + 1))
                else
                    local NV_DEVNUMS=$(get_cgroup_devnums "/dev/nvidia\${NV_MINOR}")
                    CONF_LINES+="\nlxc.mount.entry: /dev/nvidia\${NV_MINOR} dev/nvidia\${NV_MINOR} none bind,optional,create=file 0 0"
                    if [ -n "$NV_DEVNUMS" ]; then
                        CONF_LINES+="\nlxc.cgroup2.devices.allow: c $(echo $NV_DEVNUMS | awk '{print $1}'):$(echo $NV_DEVNUMS | awk '{print $2}') rwm"
                    fi
                fi
            else
                proxlab_warn "CT $VMID:   could not resolve nvidia minor for GPU $i (UUID: $UUID)"
            fi
        fi
    done

    # NVIDIA shared devices (needed by all NVIDIA containers)
    if [ "$HAS_NVIDIA" -eq 1 ]; then
        local NV_SHARED=("nvidiactl" "nvidia-modeset" "nvidia-uvm" "nvidia-uvm-tools")
        for dev in "\${NV_SHARED[@]}"; do
            if [ -e "/dev/$dev" ]; then
                if [ "$MOUNT_STYLE" = "new" ]; then
                    CONF_LINES+="\ndev\${DEV_INDEX}: /dev/$dev"
                    DEV_INDEX=$((DEV_INDEX + 1))
                else
                    local DEVNUMS=$(get_cgroup_devnums "/dev/$dev")
                    CONF_LINES+="\nlxc.mount.entry: /dev/$dev dev/$dev none bind,optional,create=file 0 0"
                    if [ -n "$DEVNUMS" ]; then
                        CONF_LINES+="\nlxc.cgroup2.devices.allow: c $(echo $DEVNUMS | awk '{print $1}'):$(echo $DEVNUMS | awk '{print $2}') rwm"
                    fi
                fi
            fi
        done

        # NVIDIA capability devices (/dev/nvidia-caps/*)
        if [ -d "/dev/nvidia-caps" ]; then
            for entry in /dev/nvidia-caps/*; do
                [ -c "$entry" ] || continue
                local capname=$(basename "$entry")
                if [ "$MOUNT_STYLE" = "new" ]; then
                    CONF_LINES+="\ndev\${DEV_INDEX}: $entry"
                    DEV_INDEX=$((DEV_INDEX + 1))
                else
                    local CAP_DEVNUMS=$(get_cgroup_devnums "$entry")
                    CONF_LINES+="\nlxc.mount.entry: $entry dev/nvidia-caps/$capname none bind,optional,create=file 0 0"
                    if [ -n "$CAP_DEVNUMS" ]; then
                        CONF_LINES+="\nlxc.cgroup2.devices.allow: c $(echo $CAP_DEVNUMS | awk '{print $1}'):$(echo $CAP_DEVNUMS | awk '{print $2}') rwm"
                    fi
                fi
            done
        fi
    fi

    # Write entries to conf between markers
    if [ -n "$CONF_LINES" ]; then
        {
            echo "$MARKER_START"
            echo -e "$CONF_LINES"
            echo "$MARKER_END"
        } >> "$CONF"
        proxlab_ok "CT $VMID: GPU config written ($DEV_INDEX device entries)"
    fi
}

do_post_stop() {
    # NOTE: We intentionally do NOT clean GPU entries on stop.
    # PVE loads/parses the conf BEFORE running the pre-start hookscript,
    # so entries must already be present in the file for the next start.
    # Cleanup happens only during demotion (saveAndRemove in JS).
    proxlab_ok "CT $VMID: post-stop (GPU entries preserved for next start)"
}

case "$PHASE" in
    pre-start)
        do_pre_start
        ;;
    post-stop)
        do_post_stop
        ;;
esac

exit 0
`;
  }

  generateSharedHookScript() {
    return `#!/bin/bash
# ProxLab Shared Folder Mount Hook - auto-deployed, do not edit manually
# Reads PROXLAB_SHARED_* vars and writes mp entries to LXC conf.

VMID="$1"
PHASE="$2"
CONF="/etc/pve/lxc/\${VMID}.conf"
MARKER_START="# proxlab-shared-start"
MARKER_END="# proxlab-shared-end"

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
[ -f "\${SCRIPT_DIR}/common.sh" ] && source "\${SCRIPT_DIR}/common.sh"
type proxlab_log &>/dev/null || proxlab_log() { echo "[ProxLab] $*"; }
type proxlab_ok &>/dev/null || proxlab_ok() { echo "[ProxLab] $*"; }
type proxlab_warn &>/dev/null || proxlab_warn() { echo "[ProxLab] $*"; }

# Find the next available mp index (skipping our own marker block)
find_next_mp_index() {
    local max=-1
    while IFS= read -r line; do
        local idx
        idx=$(echo "$line" | grep -oP '^mp(\\d+):' | grep -oP '\\d+')
        if [ -n "$idx" ] && [ "$idx" -gt "$max" ]; then
            max=$idx
        fi
    done < <(sed '/^'"$MARKER_START"'$/,/^'"$MARKER_END"'$/d' "$CONF" 2>/dev/null | grep '^mp[0-9]*:')
    echo $((max + 1))
}

clean_shared_entries() {
    if grep -q "$MARKER_START" "$CONF" 2>/dev/null; then
        sed -i "/^\${MARKER_START}$/,/^\${MARKER_END}$/d" "$CONF"
        proxlab_log "CT $VMID: cleaned previous shared folder entries"
    fi
}

do_pre_start() {
    local SHARED_COUNT=\${PROXLAB_SHARED_COUNT:-0}
    if [ "$SHARED_COUNT" -eq 0 ]; then
        return 0
    fi

    proxlab_log "CT $VMID: configuring $SHARED_COUNT shared folder mount(s)"
    clean_shared_entries

    local MP_IDX=$(find_next_mp_index)
    local CONF_LINES=""

    for i in $(seq 1 $SHARED_COUNT); do
        local HOST_VAR="PROXLAB_SHARED_\${i}_HOST"
        local GUEST_VAR="PROXLAB_SHARED_\${i}_GUEST"
        local HOST_PATH=\${!HOST_VAR}
        local GUEST_PATH=\${!GUEST_VAR}

        if [ -z "$HOST_PATH" ] || [ -z "$GUEST_PATH" ]; then
            proxlab_warn "CT $VMID: shared mount $i missing host or guest path, skipping"
            continue
        fi

        if [ ! -d "$HOST_PATH" ]; then
            proxlab_warn "CT $VMID: host path not found: $HOST_PATH — skipping"
            continue
        fi

        CONF_LINES+="mp\${MP_IDX}: \${HOST_PATH},mp=\${GUEST_PATH}\\n"
        proxlab_ok "CT $VMID: mp\${MP_IDX}: \${HOST_PATH} -> \${GUEST_PATH}"
        MP_IDX=$((MP_IDX + 1))
    done

    if [ -n "$CONF_LINES" ]; then
        {
            echo "$MARKER_START"
            echo -e "$CONF_LINES"
            echo "$MARKER_END"
        } >> "$CONF"
    fi
}

case "$PHASE" in
    pre-start)
        do_pre_start
        ;;
esac

exit 0
`;
  }

  generateCacheHookScript() {
    return `#!/bin/bash
# ProxLab Cache Restore Hook - auto-deployed, do not edit manually
# Restores cached models from NAS to tmpfs RAM drive after container start.
# Reads PROXLAB_CACHE_* vars set by ProxLab UI (host paths, not container paths).
# Copies run SEQUENTIALLY in a background subshell to prevent partial caches.
VMID="$1"
PHASE="$2"
[ "$PHASE" = "post-start" ] || exit 0

if [ "\${PROXLAB_CACHE_COUNT:-0}" -eq 0 ]; then
    exit 0
fi

proxlab_log "Restoring \${PROXLAB_CACHE_COUNT} cached model dir(s) on host ..."

# Run sequential copies in a background subshell so hookscript returns quickly
(
  for i in \\$(seq 0 \\$((\${PROXLAB_CACHE_COUNT} - 1))); do
    eval src="\\$PROXLAB_CACHE_\${i}_SRC"
    eval dst="\\$PROXLAB_CACHE_\${i}_DST"
    [ -z "\\$src" ] || [ -z "\\$dst" ] && continue
    proxlab_log "  Copying: \\$src -> \\$dst"
    mkdir -p "\\$dst" && cp "\\$src"/*.gguf "\\$dst/"
    proxlab_log "  Done: \\$dst"
  done
  proxlab_ok "All cache restores complete"
) &

proxlab_ok "Cache restore initiated (sequential copies in background)"
exit 0
`;
  }

  /**
   * Generate per-container vars file content.
   * Includes GPU vars and shared folder mount vars.
   */
  generateContainerVars(vmid, assignment, inventory, gpuConfig) {
    const { mountStyle, gpus } = assignment;

    // Build PCI → GPU info lookup from inventory
    const gpuInfoMap = {};
    for (const [nodeName, nodeInfo] of Object.entries(inventory)) {
      for (const gpu of nodeInfo.allGpus) {
        gpuInfoMap[gpu.pciId] = {
          ...gpu,
          node: nodeName,
          uuid: nodeInfo.uuidMap?.[gpu.pciId] || gpu.uuid || '',
        };
      }
    }

    let lines = `# ProxLab vars for CT ${vmid} - auto-generated\n`;
    lines += `# Generated: ${new Date().toISOString()}\n`;
    lines += `PROXLAB_MOUNT_STYLE="${mountStyle}"\n`;
    lines += `PROXLAB_GPU_COUNT=${gpus.length}\n`;

    for (let i = 0; i < gpus.length; i++) {
      const pciId = gpus[i];
      const info = gpuInfoMap[pciId] || {};
      const idx = i + 1;

      // Vendor detection
      const rawVendor = (info.vendor || '').toUpperCase();
      let vendor = 'unknown';
      if (rawVendor.includes('NVIDIA')) vendor = 'nvidia';
      else if (rawVendor.includes('AMD') || rawVendor.includes('ADVANCED MICRO')) vendor = 'amd';
      else if (rawVendor.includes('INTEL')) vendor = 'intel';

      // Name: prefer friendlyName from gpuConfig, else productName
      const configKey = `${info.node}:${pciId}`;
      const friendlyName = gpuConfig?.[configKey]?.friendlyName || info.productName || info.device || 'Unknown';
      const safeName = friendlyName.replace(/[^a-zA-Z0-9_#.-]/g, '_');

      // UUID only for NVIDIA
      const uuid = vendor === 'nvidia' ? (info.uuid || '') : '';

      lines += `PROXLAB_GPU_${idx}_PCI="${pciId}"\n`;
      lines += `PROXLAB_GPU_${idx}_NAME="${safeName}"\n`;
      lines += `PROXLAB_GPU_${idx}_VENDOR="${vendor}"\n`;
      if (uuid) {
        lines += `PROXLAB_GPU_${idx}_UUID="${uuid}"\n`;
      }
    }

    // Shared folder mount vars
    const sfConfig = loadSharedFoldersSync();
    const vmidStr = String(vmid);
    const bindings = sfConfig.containerBindings?.[vmidStr] || [];
    const mountParent = sfConfig.containerMountParent || '/mnt/shared';
    const categories = sfConfig.categories || {};

    // Filter to categories that are bound to this container AND have a hostPath
    const enabledFolders = [];
    for (const catKey of bindings) {
      const cat = categories[catKey];
      if (cat?.hostPath) {
        enabledFolders.push({
          key: catKey,
          hostPath: cat.hostPath,
          containerPath: `${mountParent}/${catKey}`,
        });
      }
    }

    lines += `\n# Shared folder mounts\n`;
    lines += `PROXLAB_SHARED_COUNT=${enabledFolders.length}\n`;
    for (let i = 0; i < enabledFolders.length; i++) {
      const f = enabledFolders[i];
      const idx = i + 1;
      lines += `PROXLAB_SHARED_${idx}_HOST="${f.hostPath}"\n`;
      lines += `PROXLAB_SHARED_${idx}_GUEST="${f.containerPath}"\n`;
      lines += `PROXLAB_SHARED_${idx}_KEY="${f.key}"\n`;
    }

    // Model cache entries (for post-start restore to tmpfs)
    // Hookscript runs on PVE host, so translate to host paths when available
    const cacheManifest = loadCacheManifestSync();
    const cacheEntries = (cacheManifest.entries || []).filter(e => e.vmid === parseInt(vmid, 10) && e.cachedAt);
    const aiConfig = loadAiConfigSync();
    const nodeEntry = Object.entries(aiConfig.agents || {}).find(([_, a]) => a.vmid === parseInt(vmid, 10));
    const cacheConfig = nodeEntry?.[1]?.cache;
    lines += `\n# Model cache (tmpfs restore on boot)\n`;
    lines += `PROXLAB_CACHE_COUNT=${cacheEntries.length}\n`;
    for (let i = 0; i < cacheEntries.length; i++) {
      const c = cacheEntries[i];
      let src = c.sourceDir;
      let dst = c.cacheDir;
      // Translate to host paths if config available
      if (cacheConfig?.modelsHostPath && src.startsWith('/models')) {
        src = cacheConfig.modelsHostPath + src.substring('/models'.length);
      }
      if (cacheConfig?.hostPath && cacheConfig?.containerPath && dst.startsWith(cacheConfig.containerPath)) {
        dst = cacheConfig.hostPath + dst.substring(cacheConfig.containerPath.length);
      }
      lines += `PROXLAB_CACHE_${i}_SRC="${src}"\n`;
      lines += `PROXLAB_CACHE_${i}_DST="${dst}"\n`;
    }

    return lines;
  }

  // --- SSH helpers ---

  async getTargetNode(vmid) {
    const guest = this.pveApi.getGuests().find(g => g.vmid === parseInt(vmid, 10));
    if (!guest) return null;

    const nodes = this.pveApi.cachedNodes;
    const nodeEntry = nodes.find(n => n.node === guest.node && n.online && n.ip);
    if (!nodeEntry) {
      // Fallback: any online node (shared storage is accessible from all)
      return nodes.find(n => n.online && n.ip) || null;
    }
    return nodeEntry;
  }

  async getOwnerNode(vmid) {
    const guest = this.pveApi.getGuests().find(g => g.vmid === parseInt(vmid, 10));
    if (!guest) return null;

    const nodes = this.pveApi.cachedNodes;
    const nodeEntry = nodes.find(n => n.node === guest.node && n.online && n.ip);
    if (nodeEntry) return nodeEntry;

    // Fallback: use the node IP from the guest's enriched data
    if (guest.nodeIp) {
      return { node: guest.node, ip: guest.nodeIp, online: true };
    }

    return null;
  }

  async sshWriteFile(nodeIp, remotePath, content, mode = '644') {
    const cmd = `mkdir -p "$(dirname '${remotePath}')" && cat > '${remotePath}' << 'PROXLAB_DEPLOY_EOF'\n${content}PROXLAB_DEPLOY_EOF\nchmod ${mode} '${remotePath}'`;
    return this.sshService.exec(nodeIp, cmd, { timeout: 15000 });
  }

  async sshDeleteFile(nodeIp, remotePath) {
    return this.sshService.exec(nodeIp, `rm -f '${remotePath}'`, { timeout: 10000 });
  }

  async sshFileExists(nodeIp, remotePath) {
    const { code } = await this.sshService.exec(nodeIp, `test -f '${remotePath}'`, { timeout: 5000 });
    return code === 0;
  }

  // --- Static file deployment (lazy, once per session) ---

  async ensureStaticFiles(nodeIp) {
    if (this.staticDeployed) return;

    const master = this.generateMasterScript();
    const common = this.generateCommonScript();
    const gpuHook = this.generateGpuHookScript();

    await this.sshWriteFile(nodeIp, `${this.snippetsBase}/proxlab-master.sh`, master, '755');
    await this.sshWriteFile(nodeIp, `${this.snippetsBase}/proxlab-hooks/common.sh`, common, '644');
    await this.sshWriteFile(nodeIp, `${this.snippetsBase}/proxlab-hooks/gpu-hook.sh`, gpuHook, '755');

    const sharedHook = this.generateSharedHookScript();
    await this.sshWriteFile(nodeIp, `${this.snippetsBase}/proxlab-hooks/shared-hook.sh`, sharedHook, '755');

    const cacheHook = this.generateCacheHookScript();
    await this.sshWriteFile(nodeIp, `${this.snippetsBase}/proxlab-hooks/cache-hook.sh`, cacheHook, '755');

    this.staticDeployed = true;
    console.log('HookscriptDeploy: static files deployed to PVE storage');
  }

  // --- Per-container operations ---

  async deployContainerVars(vmid, assignment) {
    const node = await this.getTargetNode(vmid);
    if (!node) throw new Error(`No reachable PVE node for CT ${vmid}`);

    await this.ensureStaticFiles(node.ip);

    const inventory = this.gpuMonitor.getInventory();
    const gpuConfig = this.gpuMonitor.getConfig();
    const content = this.generateContainerVars(vmid, assignment, inventory, gpuConfig);

    await this.sshWriteFile(node.ip, `${this.snippetsBase}/proxlab-vars/${vmid}.sh`, content, '644');
    return { action: 'written', path: `proxlab-vars/${vmid}.sh` };
  }

  async removeContainerVars(vmid) {
    const node = await this.getTargetNode(vmid);
    if (!node) throw new Error(`No reachable PVE node for CT ${vmid}`);

    await this.sshDeleteFile(node.ip, `${this.snippetsBase}/proxlab-vars/${vmid}.sh`);
    return { action: 'removed', path: `proxlab-vars/${vmid}.sh` };
  }

  // --- Hookscript registration via pct set ---

  async registerHookscript(vmid, node, { force = false } = {}) {
    if (!node) {
      node = await this.getOwnerNode(vmid);
      if (!node) return { action: 'skipped', reason: 'No reachable owner node' };
    }

    const { stdout } = await this.sshService.exec(
      node.ip,
      `pct config ${vmid} 2>/dev/null | grep -oP '^hookscript:\\s*\\K.*'`,
      { timeout: 10000 }
    );

    // Extract hookscript ref, filtering out MOTD/banner noise.
    // A valid hookscript ref matches "storageName:snippets/filename.sh"
    const hookRefPattern = /^[A-Za-z][\w-]*:\w+\/.+\.sh$/;
    const currentRef = stdout.trim().split('\n')
      .map(l => l.trim())
      .filter(l => hookRefPattern.test(l))
      .pop() || '';

    if (currentRef) {
      if (currentRef === this.hookscriptRef) {
        return { action: 'already', reason: 'Already registered' };
      }
      if (!force) {
        return { action: 'skipped', reason: `Container has different hookscript: ${currentRef}` };
      }
      // Force mode: replace existing hookscript
    }

    const result = await this.sshService.exec(
      node.ip,
      `pct set ${vmid} -hookscript ${this.hookscriptRef}`,
      { timeout: 15000 }
    );

    if (result.code !== 0) {
      throw new Error(`pct set failed: ${result.stderr}`);
    }

    return { action: force && currentRef ? 'replaced' : 'registered', previous: currentRef || null };
  }

  async unregisterHookscript(vmid, node) {
    if (!node) {
      node = await this.getOwnerNode(vmid);
      if (!node) return { action: 'skipped', reason: 'No reachable owner node' };
    }

    const { stdout } = await this.sshService.exec(
      node.ip,
      `pct config ${vmid} 2>/dev/null | grep -oP '^hookscript:\\s*\\K.*'`,
      { timeout: 10000 }
    );

    // Filter for valid hookscript refs (ignore MOTD noise)
    const hookRefPattern = /^[A-Za-z][\w-]*:\w+\/.+\.sh$/;
    const currentRef = stdout.trim().split('\n')
      .map(l => l.trim())
      .filter(l => hookRefPattern.test(l))
      .pop() || '';

    if (!currentRef) {
      return { action: 'already', reason: 'No hookscript set' };
    }

    if (currentRef !== this.hookscriptRef) {
      return { action: 'skipped', reason: `Not our hookscript: ${currentRef}` };
    }

    const result = await this.sshService.exec(
      node.ip,
      `pct set ${vmid} -delete hookscript`,
      { timeout: 15000 }
    );

    if (result.code !== 0) {
      throw new Error(`pct set -delete hookscript failed: ${result.stderr}`);
    }

    return { action: 'unregistered' };
  }

  // --- Combined entry points ---

  /**
   * Pre-write GPU entries to the LXC conf via SSH.
   * PVE loads/parses the conf BEFORE running hookscripts, so entries
   * must already be present in the file for the container start to pick them up.
   * This runs the gpu-hook.sh script manually on the owner node.
   */
  async preWriteGpuEntries(vmid) {
    const node = await this.getOwnerNode(vmid);
    if (!node) return { action: 'skipped', reason: 'No reachable owner node' };

    const varsFile = `${this.snippetsBase}/proxlab-vars/${vmid}.sh`;
    const hookScript = `${this.snippetsBase}/proxlab-hooks/gpu-hook.sh`;

    // Source vars (with set -a for auto-export) then run the gpu-hook pre-start
    const cmd = `set -a && source '${varsFile}' && set +a && bash '${hookScript}' ${vmid} pre-start 2>&1`;
    const result = await this.sshService.exec(node.ip, cmd, { timeout: 30000 });

    return {
      action: result.code === 0 ? 'written' : 'error',
      code: result.code,
      output: result.stdout?.trim() || '',
    };
  }

  /**
   * Pre-write shared folder mount entries to the LXC conf via SSH.
   * Runs shared-hook.sh manually on the owner node.
   */
  async preWriteSharedEntries(vmid) {
    const node = await this.getOwnerNode(vmid);
    if (!node) return { action: 'skipped', reason: 'No reachable owner node' };

    const varsFile = `${this.snippetsBase}/proxlab-vars/${vmid}.sh`;
    const hookScript = `${this.snippetsBase}/proxlab-hooks/shared-hook.sh`;

    const cmd = `set -a && source '${varsFile}' && set +a && bash '${hookScript}' ${vmid} pre-start 2>&1`;
    const result = await this.sshService.exec(node.ip, cmd, { timeout: 30000 });

    return {
      action: result.code === 0 ? 'written' : 'error',
      code: result.code,
      output: result.stdout?.trim() || '',
    };
  }

  /**
   * Clean shared folder entries from LXC conf.
   */
  async cleanSharedEntries(vmid) {
    const node = await this.getOwnerNode(vmid);
    if (!node) return { action: 'skipped', reason: 'No reachable owner node' };

    const confPath = `/etc/pve/lxc/${vmid}.conf`;
    const cleanCmd = `sed -i '/^# proxlab-shared-start$/,/^# proxlab-shared-end$/d' '${confPath}'`;

    const result = await this.sshService.exec(node.ip, cleanCmd, { timeout: 15000 });
    return { action: result.code === 0 ? 'cleaned' : 'error', code: result.code };
  }

  async saveAndDeploy(vmid, assignment, { force = false } = {}) {
    const vars = await this.deployContainerVars(vmid, assignment);
    const hookscript = await this.registerHookscript(vmid, null, { force });

    // Pre-write GPU entries to conf so they're available on first start.
    // PVE parses the conf before the hookscript runs, so entries must be present beforehand.
    let gpuEntries;
    try {
      gpuEntries = await this.preWriteGpuEntries(vmid);
    } catch (err) {
      gpuEntries = { action: 'error', error: err.message };
    }

    // Pre-write shared folder entries
    let sharedEntries;
    try {
      sharedEntries = await this.preWriteSharedEntries(vmid);
    } catch (err) {
      sharedEntries = { action: 'error', error: err.message };
    }

    return { vars, hookscript, gpuEntries, sharedEntries };
  }

  /**
   * Deploy shared folder mounts for a container that has no GPU assignment.
   * Registers the hookscript and writes shared entries only.
   */
  async saveAndDeployShared(vmid, sharedFolders) {
    const node = await this.getTargetNode(vmid);
    if (!node) throw new Error(`No reachable PVE node for CT ${vmid}`);

    await this.ensureStaticFiles(node.ip);

    // Generate vars with empty GPU assignment but shared folder data
    const sfConfig = sharedFolders || loadSharedFoldersSync();
    const vmidStr = String(vmid);
    const bindings = sfConfig.containerBindings?.[vmidStr] || [];
    const mountParent = sfConfig.containerMountParent || '/mnt/shared';
    const categories = sfConfig.categories || {};

    const enabledFolders = [];
    for (const catKey of bindings) {
      const cat = categories[catKey];
      if (cat?.hostPath) {
        enabledFolders.push({
          key: catKey,
          hostPath: cat.hostPath,
          containerPath: `${mountParent}/${catKey}`,
        });
      }
    }

    let lines = `# ProxLab vars for CT ${vmid} - auto-generated\n`;
    lines += `# Generated: ${new Date().toISOString()}\n`;
    lines += `PROXLAB_GPU_COUNT=0\n`;
    lines += `\n# Shared folder mounts\n`;
    lines += `PROXLAB_SHARED_COUNT=${enabledFolders.length}\n`;
    for (let i = 0; i < enabledFolders.length; i++) {
      const f = enabledFolders[i];
      const idx = i + 1;
      lines += `PROXLAB_SHARED_${idx}_HOST="${f.hostPath}"\n`;
      lines += `PROXLAB_SHARED_${idx}_GUEST="${f.containerPath}"\n`;
      lines += `PROXLAB_SHARED_${idx}_KEY="${f.key}"\n`;
    }

    await this.sshWriteFile(node.ip, `${this.snippetsBase}/proxlab-vars/${vmid}.sh`, lines, '644');
    const hookscript = await this.registerHookscript(vmid, null, { force: false });

    let sharedEntries;
    try {
      sharedEntries = await this.preWriteSharedEntries(vmid);
    } catch (err) {
      sharedEntries = { action: 'error', error: err.message };
    }

    return { vars: { action: 'written' }, hookscript, sharedEntries };
  }

  async cleanGpuEntries(vmid) {
    const node = await this.getOwnerNode(vmid);
    if (!node) return { action: 'skipped', reason: 'No reachable owner node' };

    // Remove marker block + any stray GPU entries from LXC conf
    const confPath = `/etc/pve/lxc/${vmid}.conf`;
    const cleanCmd = [
      `sed -i '/^# proxlab-gpu-start$/,/^# proxlab-gpu-end$/d' '${confPath}'`,
      `sed -i '/^lxc\\.mount\\.entry:.*dev\\/dri/d' '${confPath}'`,
      `sed -i '/^lxc\\.mount\\.entry:.*dev\\/nvidia/d' '${confPath}'`,
      `sed -i '/^lxc\\.cgroup2\\.devices\\.allow:/d' '${confPath}'`,
      `sed -i '/^dev[0-9]*:.*\\/dev\\/dri\\//d' '${confPath}'`,
      `sed -i '/^dev[0-9]*:.*\\/dev\\/nvidia/d' '${confPath}'`,
      `sed -i '/^lxc\\.mount\\.entry:.*dev\\/nvidia-caps/d' '${confPath}'`,
    ].join(' && ');

    const result = await this.sshService.exec(node.ip, cleanCmd, { timeout: 15000 });
    return { action: result.code === 0 ? 'cleaned' : 'error', code: result.code };
  }

  async saveAndRemove(vmid) {
    const vars = await this.removeContainerVars(vmid);
    const hookscript = await this.unregisterHookscript(vmid);
    let confClean;
    try {
      confClean = await this.cleanGpuEntries(vmid);
    } catch (err) {
      confClean = { action: 'error', error: err.message };
    }
    let sharedClean;
    try {
      sharedClean = await this.cleanSharedEntries(vmid);
    } catch (err) {
      sharedClean = { action: 'error', error: err.message };
    }
    return { vars, hookscript, confClean, sharedClean };
  }
}
