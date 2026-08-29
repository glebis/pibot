#!/bin/bash
# Install pibot as a launchd user agent: starts on login, restarts on crash.
# Usage: scripts/install-daemon.sh [--uninstall]
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LABEL="com.glebkalinin.pibot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$ROOT/data/daemon.log"

NODE_BIN="$(command -v node)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(ls "$HOME/.hermes/node/bin/node" 2>/dev/null | head -1)"
[ -z "$NODE_BIN" ] && { echo "node not found"; exit 1; }

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "daemon removed"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>node_modules/tsx/dist/cli.mjs</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PIBOT_TRANSPORT</key><string>telegram</string>
    <key>PIBOT_DEFAULT_MODEL</key><string>xai/grok-4.6</string>
    <key>TELEGRAM_ALLOWED_CHATS</key><string>${TELEGRAM_ALLOWED_CHATS:-161427550}</string>
    <key>PIBOT_WEB</key><string>1</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>$ROOT/data/daemon.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/daemon.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
sleep 2
launchctl list | grep "$LABEL" || true
echo "pibot daemon installed → logs: $ROOT/data/daemon.log"
echo "dashboard: http://127.0.0.1:7860 · logs: tail -f $ROOT/data/daemon.log"