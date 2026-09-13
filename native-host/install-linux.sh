#!/usr/bin/env bash
# Registers the Focus Cap native messaging host for Chrome/Chromium on Linux
# (tested target: Ubuntu). Usage: ./install-linux.sh [EXTENSION_ID]
# manifest.json pins a stable ID via its "key" field, so as long as you loaded
# the repo's own manifest.json unpacked, the default below is already correct
# and you don't need to pass anything. Only pass an EXTENSION_ID if you
# regenerated your own "key" (and therefore a different ID).
set -euo pipefail

DEFAULT_EXTENSION_ID="oladakapegoiphmpicedkgnieanibbbe"
EXTENSION_ID="${1:-$DEFAULT_EXTENSION_ID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$SCRIPT_DIR/host.js"

# Registers for whichever of these browsers are installed; harmless to
# create both if you're not sure which one you use.
TARGET_DIRS=(
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
)

for TARGET_DIR in "${TARGET_DIRS[@]}"; do
  mkdir -p "$TARGET_DIR"
  sed \
    -e "s#__HOST_PATH__#$SCRIPT_DIR/host.js#" \
    -e "s#__EXTENSION_ID__#$EXTENSION_ID#" \
    "$SCRIPT_DIR/com.focuscap.host.json.template" \
    > "$TARGET_DIR/com.focuscap.host.json"
  echo "Registered: $TARGET_DIR/com.focuscap.host.json"
done

echo "Restart your browser for it to take effect."
