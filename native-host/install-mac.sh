#!/usr/bin/env bash
# Registers the Focus Cap native messaging host for Chrome on macOS.
# Usage: ./install-mac.sh <EXTENSION_ID>
# Find <EXTENSION_ID> at chrome://extensions with Developer mode on, after
# loading the unpacked extension from the repo root.
set -euo pipefail

EXTENSION_ID="${1:?Usage: ./install-mac.sh <EXTENSION_ID>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

chmod +x "$SCRIPT_DIR/host.js"
mkdir -p "$TARGET_DIR"

sed \
  -e "s#__HOST_PATH__#$SCRIPT_DIR/host.js#" \
  -e "s#__EXTENSION_ID__#$EXTENSION_ID#" \
  "$SCRIPT_DIR/com.focuscap.host.json.template" \
  > "$TARGET_DIR/com.focuscap.host.json"

echo "Registered native messaging host at:"
echo "  $TARGET_DIR/com.focuscap.host.json"
echo "Restart Chrome for it to take effect."
