"""Synthetic binary IPC child; no model/network or original audio/text logging."""
import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--assets", type=Path, required=True)
args = parser.parse_args()
signal.signal(signal.SIGTERM, lambda *_args: None)
sys.stdout.buffer.write(b'{"event":"ready","weightsVerified":true}\n')
sys.stdout.buffer.flush()
for line in sys.stdin.buffer:
    header = json.loads(line)
    data = sys.stdin.buffer.read(header["bytes"])
    count = args.assets / "request-count"
    count.write_text(str(int(count.read_text()) + 1 if count.exists() else 1))
    if data == b"slow":
        (args.assets / "started").write_text(str(os.getpid()))
        time.sleep(30)
    if data == b"malformed":
        sys.stdout.buffer.write(b'{"bytes":false}\n')
        sys.stdout.buffer.flush()
        continue
    result = json.dumps({"text": "Synthetic fixture transcript."}, separators=(",", ":")).encode()
    sys.stdout.buffer.write(json.dumps({"bytes": len(result)}).encode() + b"\n" + result)
    sys.stdout.buffer.flush()
