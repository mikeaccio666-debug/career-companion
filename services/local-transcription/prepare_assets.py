"""Explicit development setup only. The HTTP worker never imports this downloader."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request

MANIFEST = Path(__file__).with_name("assets.json")


def digest(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError("ASSET_UNAVAILABLE")
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def prepare(directory: Path) -> None:
    manifest = json.loads(MANIFEST.read_text())
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        raise ValueError("UNSAFE_ASSET_DIRECTORY")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for asset in manifest["assets"]:
        target = directory / asset["file"]
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not target.resolve().is_relative_to(directory.resolve()) or target.is_symlink():
            raise ValueError("UNSAFE_ASSET_PATH")
        if target.exists() and digest(target) == asset["sha256"]:
            print(json.dumps({"asset": asset["file"], "status": "verified"}), flush=True)
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                request = urllib.request.Request(asset["url"], headers={"User-Agent": "Companion-local-transcription-setup/1"})
                with opener.open(request, timeout=45) as response:
                    if response.status != 200 or not response.geturl().startswith("https://"):
                        raise ValueError("ASSET_DOWNLOAD_REJECTED")
                    total = 0
                    h = hashlib.sha256()
                    for chunk in iter(lambda: response.read(1024 * 1024), b""):
                        total += len(chunk)
                        if total > asset.get("size", asset.get("maxBytes", 0)):
                            raise ValueError("ASSET_SIZE_MISMATCH")
                        h.update(chunk)
                        output.write(chunk)
                if ("size" in asset and total != asset["size"]) or h.hexdigest() != asset["sha256"]:
                    raise ValueError("ASSET_HASH_MISMATCH")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
            temporary = None
            print(json.dumps({"asset": asset["file"], "status": "downloaded_verified", "bytes": total}), flush=True)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True, type=Path)
    args = parser.parse_args()
    try:
        prepare(args.directory)
    except Exception:
        print(json.dumps({"error": {"code": "ASSET_PREPARATION_FAILED", "message": "Public asset preparation failed; no HTTP service was started."}}))
        raise SystemExit(1)
