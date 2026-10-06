#!/usr/bin/env bash
set -euo pipefail
service_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_dir="$(cd "$service_dir/../.." && pwd)"
transcription_state="${LOCAL_TRANSCRIPTION_STATE_DIR:-$workspace_dir/.local/platform/local-transcription}"
if [[ ! -x "$transcription_state/.venv/bin/python" ]]; then
  printf '%s\n' 'Run services/local-transcription/setup.sh explicitly before serving.' >&2
  exit 1
fi
PYTHONDONTWRITEBYTECODE=1 exec "$transcription_state/.venv/bin/python" "$service_dir/server.py" --assets "$transcription_state/models" "$@"
