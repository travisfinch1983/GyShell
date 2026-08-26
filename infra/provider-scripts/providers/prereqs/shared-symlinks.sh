#!/bin/bash
# ProxLab Shared Folder Symlink Helper
# Sourced by provider install scripts to create symlinks from provider-internal
# paths to shared mount points. Safe and idempotent — returns 0 if mount
# doesn't exist.
#
# Usage (in provider script):
#   source /tmp/proxlab-install/providers/prereqs/shared-symlinks.sh
#   proxlab_symlink "rvc-models" "$INSTALL_DIR/models/rvc_voices"
#   proxlab_symlink "llm-models" "$INSTALL_DIR/models"

SHARED_MOUNT_PARENT="${PROXLAB_SHARED_MOUNT_PARENT:-/mnt/shared}"

proxlab_symlink() {
    local CATEGORY="$1"
    local TARGET_PATH="$2"
    local SHARED_PATH="${SHARED_MOUNT_PARENT}/${CATEGORY}"

    # Skip if shared mount doesn't exist
    if [ ! -d "$SHARED_PATH" ]; then
        echo "  [shared] Mount not found: $SHARED_PATH — skipping $CATEGORY"
        return 0
    fi

    # Already a correct symlink — skip
    if [ -L "$TARGET_PATH" ]; then
        local CURRENT_TARGET
        CURRENT_TARGET=$(readlink -f "$TARGET_PATH")
        local SHARED_REAL
        SHARED_REAL=$(readlink -f "$SHARED_PATH")
        if [ "$CURRENT_TARGET" = "$SHARED_REAL" ]; then
            echo "  [shared] $CATEGORY already linked: $TARGET_PATH -> $SHARED_PATH"
            return 0
        fi
        # Symlink points somewhere else — replace it
        echo "  [shared] Updating symlink: $TARGET_PATH -> $SHARED_PATH (was: $CURRENT_TARGET)"
        rm -f "$TARGET_PATH"
        ln -s "$SHARED_PATH" "$TARGET_PATH"
        return 0
    fi

    # If target is an existing directory with content, move it to shared
    if [ -d "$TARGET_PATH" ]; then
        local FILE_COUNT
        FILE_COUNT=$(find "$TARGET_PATH" -maxdepth 1 -not -name '.' | wc -l)
        if [ "$FILE_COUNT" -gt 0 ]; then
            echo "  [shared] Moving existing files from $TARGET_PATH to $SHARED_PATH"
            cp -a "$TARGET_PATH"/. "$SHARED_PATH"/ 2>/dev/null || true
        fi
        rm -rf "$TARGET_PATH"
    fi

    # Ensure parent directory exists
    mkdir -p "$(dirname "$TARGET_PATH")"

    # Create symlink
    ln -s "$SHARED_PATH" "$TARGET_PATH"
    echo "  [shared] Linked: $TARGET_PATH -> $SHARED_PATH"
    return 0
}
