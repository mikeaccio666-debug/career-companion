#!/usr/bin/env bash
set -euo pipefail
service_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_dir="$(cd "$service_dir/../.." && pwd)"
speech_state="${LOCAL_SPEECH_STATE_DIR:-$workspace_dir/.local/platform/local-speech}"
if [[ ! -x "$speech_state/.venv/bin/python" ]]; then
  printf '%s\n' 'Run services/local-speech/setup.sh explicitly before serving.' >&2
  exit 1
fi
PYTHONDONTWRITEBYTECODE=1 exec "$speech_state/.venv/bin/python" "$service_dir/server.py" --assets "$speech_state/models" "$@"
