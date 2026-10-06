"""Private small JSON header plus bounded raw audio; no base64 or prompt logs."""
import argparse
import json
import os
from pathlib import Path
import sys

from protocol import MAX_AUDIO_BYTES, TranscriptionError, result_bytes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True, type=Path)
    args = parser.parse_args()
    output = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    with open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)

    def send(header):
        output.write(json.dumps(header, separators=(",", ":")).encode() + b"\n")

    try:
        from engine import Engine
        engine = Engine(args.assets)
        send({"event": "ready", "weightsVerified": True})
    except Exception:
        send({"event": "error", "code": "LOCAL_TRANSCRIPTION_ASSETS_INVALID"})
        return 1
    while True:
        line = sys.stdin.buffer.readline(1026)
        if not line:
            return 0
        try:
            if len(line) > 1024 or not line.endswith(b"\n"):
                return 1
            header = json.loads(line)
            size = header.get("bytes")
            if set(header) != {"bytes"} or isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= MAX_AUDIO_BYTES:
                return 1
            audio = sys.stdin.buffer.read(size)
            if len(audio) != size:
                return 1
            result = result_bytes(engine.transcribe(audio))
            send({"bytes": len(result)})
            output.write(result)
        except TranscriptionError as error:
            send({"error": error.code, "status": error.status})
        except Exception:
            send({"error": "LOCAL_TRANSCRIPTION_FAILED", "status": 502})


if __name__ == "__main__":
    raise SystemExit(main())
