"""Small, fixed speech protocol; no provider keys or client-selected paths."""
import json
import unicodedata

MODEL = "kokoro-82m"
VOICE = "af_heart"
SAMPLE_RATE = 24_000
MAX_INPUT_CHARACTERS = 4_000
MAX_BODY_BYTES = 32 * 1024
MAX_WAV_BYTES = 30 * 1024 * 1024


class SpeechError(Exception):
    def __init__(self, code: str, status: int = 400):
        self.code = code
        self.status = status


MESSAGES = {
    "LOCAL_SPEECH_INVALID_INPUT": "Use the fixed English model, voice and WAV format with 1 to 4000 input characters.",
    "LOCAL_SPEECH_BODY_TOO_LARGE": "The JSON request exceeds 32 KiB.",
    "LOCAL_SPEECH_ORIGIN_REJECTED": "Call this loopback worker from the platform backend.",
    "LOCAL_SPEECH_HOST_REJECTED": "Use the worker's literal loopback host and port.",
    "LOCAL_SPEECH_CONTENT_TYPE": "Use UTF-8 application/json.",
    "LOCAL_SPEECH_BUSY": "One local speech request is already running.",
    "LOCAL_SPEECH_NOT_READY": "The local speech model is not ready.",
    "LOCAL_SPEECH_TIMEOUT": "Local speech generation exceeded its deadline.",
    "LOCAL_SPEECH_OUTPUT_LIMIT": "The generated audio exceeds the local output limit.",
    "LOCAL_SPEECH_FAILED": "Local speech generation failed.",
    "LOCAL_SPEECH_ASSETS_INVALID": "Prepare and verify the fixed local speech assets before starting the worker.",
    "LOCAL_SPEECH_CLEANUP_UNCONFIRMED": "Worker shutdown could not be confirmed; a local operator must restart the service.",
}


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise SpeechError("LOCAL_SPEECH_INVALID_INPUT")
        value[key] = item
    return value


def parse_request(body: bytes) -> str:
    if len(body) > MAX_BODY_BYTES:
        raise SpeechError("LOCAL_SPEECH_BODY_TOO_LARGE", 413)
    try:
        data = json.loads(body.decode("utf-8"), object_pairs_hook=_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        raise SpeechError("LOCAL_SPEECH_INVALID_INPUT") from None
    if not isinstance(data, dict) or set(data) != {"model", "input", "voice", "response_format"}:
        raise SpeechError("LOCAL_SPEECH_INVALID_INPUT")
    if data["model"] != MODEL or data["voice"] != VOICE or data["response_format"] != "wav":
        raise SpeechError("LOCAL_SPEECH_INVALID_INPUT")
    text = data["input"]
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_INPUT_CHARACTERS:
        raise SpeechError("LOCAL_SPEECH_INVALID_INPUT")
    try:
        text.encode("utf-8")
    except UnicodeError:
        raise SpeechError("LOCAL_SPEECH_INVALID_INPUT") from None
    # This is a script restriction, not language detection or a pronunciation guarantee.
    if any((c.isalpha() and "LATIN" not in unicodedata.name(c, ""))
           or (ord(c) < 32 and c not in "\t\n\r") or ord(c) == 127 for c in text):
        raise SpeechError("LOCAL_SPEECH_INVALID_INPUT")
    return text.strip()


def error_body(error: SpeechError) -> dict:
    return {"error": {"code": error.code, "message": MESSAGES.get(error.code, MESSAGES["LOCAL_SPEECH_FAILED"])}}
