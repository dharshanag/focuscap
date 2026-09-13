#!/usr/bin/env bash
# Registers the Focus Cap native messaging host for Chrome/Chromium on Linux
# (tested target: Ubuntu). Usage: ./install-linux.sh <EXTENSION_ID>
# Find <EXTENSION_ID> at chrome://extensions with Developer mode on, after
# loading the unpacked extension from the repo root.
set -euo pipefail

EXTENSION_ID="${1:?Usage: ./install-linux.sh <EXTENSION_ID>}"
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
