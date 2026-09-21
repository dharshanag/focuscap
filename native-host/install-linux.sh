#!/usr/bin/env bash
# Registers the Focus Cap native messaging host for Chrome/Chromium on Linux
# (tested target: Ubuntu). Usage: ./install-linux.sh [EXTENSION_ID] [USER_DATA_DIR]
# manifest.json pins a stable ID via its "key" field, so as long as you loaded
# the repo's own manifest.json unpacked, the default below is already correct
# and you don't need to pass anything. Only pass an EXTENSION_ID if you
# regenerated your own "key" (and therefore a different ID).
#
# USER_DATA_DIR (optional, also readable from $CHROME_USER_DATA_DIR): on Linux,
# Chrome looks for host manifests in <user-data-dir>/NativeMessagingHosts —
# the per-channel ~/.config/<brand> defaults below only cover Chrome's DEFAULT
# profile location. If you launch Chrome with a custom --user-data-dir
# (browser-automation tools such as agent-browser --profile do this), pass
# that directory here too, or the extension fails with
# "Specified native messaging host not found".
set -euo pipefail

DEFAULT_EXTENSION_ID="oladakapegoiphmpicedkgnieanibbbe"
EXTENSION_ID="${1:-$DEFAULT_EXTENSION_ID}"
USER_DATA_DIR="${2:-${CHROME_USER_DATA_DIR:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$SCRIPT_DIR/host.js"

# Each Chrome channel/brand reads native messaging host manifests from its
# OWN ~/.config/<brand>/NativeMessagingHosts directory — registering only
# under google-chrome silently misses Beta/Unstable/Canary and Chrome for
# Testing (the build browser-automation tools like agent-browser use), which
# then fail with "Specified native messaging host not found". Registering
# into all of them is harmless: unused directories are just ignored.
TARGET_DIRS=(
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/google-chrome-beta/NativeMessagingHosts"
  "$HOME/.config/google-chrome-unstable/NativeMessagingHosts"
  "$HOME/.config/google-chrome-for-testing/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
)
if [[ -n "$USER_DATA_DIR" ]]; then
  TARGET_DIRS+=("$USER_DATA_DIR/NativeMessagingHosts")
fi

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
