#!/usr/bin/env bash
# Registers the Focus Cap native messaging host for Chrome on macOS.
# Usage: ./install-mac.sh [EXTENSION_ID] [USER_DATA_DIR]
# manifest.json pins a stable ID via its "key" field, so as long as you loaded
# the repo's own manifest.json unpacked, the default below is already correct
# and you don't need to pass anything. Only pass an EXTENSION_ID if you
# regenerated your own "key" (and therefore a different ID).
#
# USER_DATA_DIR (optional, also readable from $CHROME_USER_DATA_DIR): on macOS,
# exactly like Linux, Chrome looks for user-level host manifests in
# <user-data-dir>/NativeMessagingHosts — the ~/Library/Application Support
# defaults below only work because they ARE the default user-data-dir of each
# channel (verified on Chrome 155: with a custom --user-data-dir the
# ~/Library manifests are never found). If you launch Chrome with a custom
# --user-data-dir (browser-automation tools such as agent-browser --profile do
# this), pass that directory here too, or the extension fails with
# "Specified native messaging host not found".
set -euo pipefail

DEFAULT_EXTENSION_ID="oladakapegoiphmpicedkgnieanibbbe"
EXTENSION_ID="${1:-$DEFAULT_EXTENSION_ID}"
USER_DATA_DIR="${2:-${CHROME_USER_DATA_DIR:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$SCRIPT_DIR/host.js"

# Each Chrome channel/brand has its OWN default user-data-dir under
# Application Support, and that is where it looks for host manifests —
# registering only under "Chrome" silently misses Beta/Canary and Chrome for
# Testing (the build browser-automation tools use), which then fail with
# "Specified native messaging host not found". Registering into all is
# harmless.
TARGET_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)
if [[ -n "$USER_DATA_DIR" ]]; then
  TARGET_DIRS+=("$USER_DATA_DIR/NativeMessagingHosts")
fi

# The manifest is built by node from the template object and written with
# JSON.stringify, not by sed-substituting placeholders: a checkout path or
# extension ID containing sed's `#`/`&`/`\` metacharacters used to produce a
# malformed manifest (issue #18). node is already a hard requirement of the
# host itself, so this adds no dependency.
MANIFEST="$(node -e '
  const fs = require("fs");
  const [template, hostPath, extensionId] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(template, "utf8"));
  manifest.path = hostPath;
  manifest.allowed_origins = ["chrome-extension://" + extensionId + "/"];
  process.stdout.write(JSON.stringify(manifest, null, 2));
' "$SCRIPT_DIR/com.focuscap.host.json.template" "$SCRIPT_DIR/host.js" "$EXTENSION_ID")"

for TARGET_DIR in "${TARGET_DIRS[@]}"; do
  mkdir -p "$TARGET_DIR"
  printf '%s\n' "$MANIFEST" > "$TARGET_DIR/com.focuscap.host.json"
  echo "Registered: $TARGET_DIR/com.focuscap.host.json"
done

# A Chrome that is already running needs a restart to pick the manifest up
# (a fresh profile finds it immediately).
echo "Restart Chrome for it to take effect."
