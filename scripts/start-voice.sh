#!/bin/sh
set -eu
VOICE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VOICE_PYTHON=${PIBOT_VOICE_PYTHON:-"$HOME/Library/Application Support/uv/tools/pipecat-ai-mcp-server/bin/python"}
if [ ! -x "$VOICE_PYTHON" ]; then
  echo 'Set PIBOT_VOICE_PYTHON to a Python environment installed from voice/requirements.txt.' >&2
  exit 1
fi
exec "$VOICE_PYTHON" "$VOICE_ROOT/scripts/voice-test.py" "$@"
