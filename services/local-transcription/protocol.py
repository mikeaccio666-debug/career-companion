"""Fixed upload/transcript contract. No client paths, prompts or remote model names."""
import json

MODEL = "whisper-tiny"
SAMPLE_RATE = 16000
MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_HTTP_BYTES = MAX_AUDIO_BYTES + 64 * 1024
MAX_DURATION_SECONDS = 120
MAX_TEXT_BYTES = 64 * 1024
MAX_JSON_BYTES = 128 * 1024
MIME_TYPES = frozenset({"audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp4",
                        "audio/webm", "audio/ogg", "audio/flac"})


class TranscriptionError(Exception):
    def __init__(self, code, status=400):
        self.code = code
        self.status = status


MESSAGES = {
    "LOCAL_TRANSCRIPTION_INVALID_INPUT": "Use exactly one fixed model field and one supported audio file.",
    "LOCAL_TRANSCRIPTION_BODY_TOO_LARGE": "The audio upload exceeds the local input limit.",
    "LOCAL_TRANSCRIPTION_INVALID_AUDIO": "The upload is not a supported audio-only recording.",
    "LOCAL_TRANSCRIPTION_DURATION_LIMIT": "Audio must be at most 120 seconds long.",
    "LOCAL_TRANSCRIPTION_ORIGIN_REJECTED": "Call this loopback worker from the platform backend.",
    "LOCAL_TRANSCRIPTION_HOST_REJECTED": "Use the worker's literal loopback host and port.",
    "LOCAL_TRANSCRIPTION_CONTENT_TYPE": "Use uncompressed multipart/form-data with a supported audio file.",
    "LOCAL_TRANSCRIPTION_BUSY": "One local transcription request is already running.",
    "LOCAL_TRANSCRIPTION_NOT_READY": "The local transcription model is not ready.",
    "LOCAL_TRANSCRIPTION_TIMEOUT": "Local transcription exceeded its deadline.",
    "LOCAL_TRANSCRIPTION_OUTPUT_LIMIT": "The generated transcript exceeds the local output limit.",
    "LOCAL_TRANSCRIPTION_FAILED": "Local transcription failed.",
    "LOCAL_TRANSCRIPTION_ASSETS_INVALID": "Prepare and verify the fixed local transcription assets before serving.",
    "LOCAL_TRANSCRIPTION_CLEANUP_UNCONFIRMED": "Worker shutdown could not be confirmed; a local operator must restart the service.",
}


def error_body(error):
    return {"error": {"code": error.code, "message": MESSAGES.get(error.code, MESSAGES["LOCAL_TRANSCRIPTION_FAILED"])}}


def result_bytes(value):
    if not isinstance(value, dict) or set(value) != {"text"} or not isinstance(value["text"], str):
        raise TranscriptionError("LOCAL_TRANSCRIPTION_FAILED", 502)
    try:
        if len(value["text"].encode("utf-8")) > MAX_TEXT_BYTES:
            raise TranscriptionError("LOCAL_TRANSCRIPTION_OUTPUT_LIMIT", 413)
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except UnicodeError:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_FAILED", 502) from None
    if len(body) > MAX_JSON_BYTES:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_OUTPUT_LIMIT", 413)
    return body
