#!/usr/bin/env bash
# Registers the Focus Cap native messaging host for Chrome on macOS.
# Usage: ./install-mac.sh [EXTENSION_ID]
# manifest.json pins a stable ID via its "key" field, so as long as you loaded
# the repo's own manifest.json unpacked, the default below is already correct
# and you don't need to pass anything. Only pass an EXTENSION_ID if you
# regenerated your own "key" (and therefore a different ID).
set -euo pipefail

DEFAULT_EXTENSION_ID="oladakapegoiphmpicedkgnieanibbbe"
EXTENSION_ID="${1:-$DEFAULT_EXTENSION_ID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$SCRIPT_DIR/host.js"

# Each Chrome channel/brand reads native messaging host manifests from its
# OWN Application Support directory — registering only under "Chrome"
# silently misses Beta/Canary and Chrome for Testing (the build
# browser-automation tools use), which then fail with "Specified native
# messaging host not found". Registering into all is harmless.
TARGET_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)

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

echo "Restart Chrome for it to take effect."
