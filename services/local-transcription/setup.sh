#!/usr/bin/env bash
set -euo pipefail
service_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_dir="$(cd "$service_dir/../.." && pwd)"
transcription_state="${LOCAL_TRANSCRIPTION_STATE_DIR:-$workspace_dir/.local/platform/local-transcription}"
transcription_python="${LOCAL_TRANSCRIPTION_PYTHON:-3.12}"
mkdir -p "$transcription_state"
if ! command -v uv >/dev/null 2>&1; then
  printf '%s\n' 'Install uv and Python 3.12 separately, then rerun this explicit setup.' >&2
  exit 1
fi
UV_CACHE_DIR="$transcription_state/uv-cache" UV_PROJECT_ENVIRONMENT="$transcription_state/.venv" \
  uv sync --project "$service_dir" --locked --python "$transcription_python" --no-python-downloads
PYTHONDONTWRITEBYTECODE=1 "$transcription_state/.venv/bin/python" "$service_dir/prepare_assets.py" --directory "$transcription_state/models"
printf '%s\n' 'Fixed local transcription dependencies and model assets verified. No server was started.'
