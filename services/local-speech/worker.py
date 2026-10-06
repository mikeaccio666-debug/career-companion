"""One reusable model child. Private framed stdio, no HTTP listener or prompt logs."""
import argparse
import json
import os
from pathlib import Path
import sys

from protocol import MAX_BODY_BYTES, SpeechError, parse_request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True, type=Path)
    args = parser.parse_args()
    # Keep a private protocol FD, then suppress package/PyTorch/C-library output.
    output = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    with open(os.devnull, "wb") as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)

    def send(value):
        output.write(json.dumps(value, separators=(",", ":")).encode() + b"\n")

    try:
        from engine import Engine
        engine = Engine(args.assets)
        send({"event": "ready", "weightsVerified": True})
    except Exception:
        send({"event": "error", "code": "LOCAL_SPEECH_ASSETS_INVALID"})
        return 1
    while True:
        body = sys.stdin.buffer.readline(MAX_BODY_BYTES + 2)
        if not body:
            return 0
        if len(body) > MAX_BODY_BYTES + 1 or not body.endswith(b"\n"):
            send({"error": "LOCAL_SPEECH_INVALID_INPUT", "status": 400})
            return 1
        try:
            text = parse_request(body[:-1])
            audio = engine.synthesize(text)
            send({"bytes": len(audio)})
            output.write(audio)
        except SpeechError as error:
            send({"error": error.code, "status": error.status})
        except Exception:
            send({"error": "LOCAL_SPEECH_FAILED", "status": 502})


if __name__ == "__main__":
    raise SystemExit(main())
