#!/usr/bin/env bash
set -euo pipefail
service_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_dir="$(cd "$service_dir/../.." && pwd)"
speech_state="${LOCAL_SPEECH_STATE_DIR:-$workspace_dir/.local/platform/local-speech}"
speech_python="${LOCAL_SPEECH_PYTHON:-3.12}"
mkdir -p "$speech_state"
if ! command -v uv >/dev/null 2>&1; then
  printf '%s\n' 'Install uv and Python 3.12 separately, then rerun this explicit setup.' >&2
  exit 1
fi
UV_CACHE_DIR="$speech_state/uv-cache" UV_PROJECT_ENVIRONMENT="$speech_state/.venv" \
  uv sync --project "$service_dir" --locked --python "$speech_python" --no-python-downloads
PYTHONDONTWRITEBYTECODE=1 "$speech_state/.venv/bin/python" "$service_dir/prepare_assets.py" --directory "$speech_state/models"
printf '%s\n' 'Fixed local speech dependencies and model assets verified. No server was started.'
