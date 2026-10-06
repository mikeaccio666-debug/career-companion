"""Synthetic framed worker. No model, network or user material."""
import argparse
import io
import json
import os
from pathlib import Path
import signal
import sys
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument("--assets", type=Path, required=True)
args = parser.parse_args()

# Intentionally require the supervisor's bounded SIGKILL path in cleanup tests.
signal.signal(signal.SIGTERM, lambda *_args: None)
output = io.BytesIO()
with wave.open(output, "wb") as stream:
    stream.setnchannels(1)
    stream.setsampwidth(2)
    stream.setframerate(24000)
    stream.writeframes(b"\x01\x00" * 240)
audio = output.getvalue()
sys.stdout.buffer.write(b'{"event":"ready","weightsVerified":true}\n')
sys.stdout.buffer.flush()
for line in sys.stdin.buffer:
    data = json.loads(line)
    count = args.assets / "request-count"
    count.write_text(str(int(count.read_text()) + 1 if count.exists() else 1))
    if data["input"] == "Slow":
        (args.assets / "started").write_text(str(os.getpid()))
        time.sleep(30)
    if data["input"] == "Malformed":
        sys.stdout.buffer.write(b'{"bytes":false}\n')
        sys.stdout.buffer.flush()
        continue
    sys.stdout.buffer.write(json.dumps({"bytes": len(audio)}).encode() + b"\n" + audio)
    sys.stdout.buffer.flush()
