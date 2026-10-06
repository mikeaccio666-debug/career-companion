import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import verify_assets
from protocol import SpeechError


class Distribution:
    files = []

    def __init__(self, version):
        self.version = version


class AssetTests(unittest.TestCase):
    def test_hash_and_size_reject_same_size_replacement_before_load(self):
        with tempfile.TemporaryDirectory(prefix="synthetic-speech-assets-") as temporary:
            directory = Path(temporary)
            body = b"fictional fixed asset"
            path = directory / "model.bin"
            path.write_bytes(body)
            manifest = {"assets": [{"file": "model.bin", "size": len(body), "sha256": hashlib.sha256(body).hexdigest()}]}
            versions = {"en-core-web-sm": "3.8.0", "misaki": "0.9.4", "espeakng-loader": "0.2.4"}
            with patch("engine.json.loads", return_value=manifest), patch("engine.importlib.metadata.distribution", side_effect=lambda name: Distribution(versions[name])):
                self.assertEqual(verify_assets(directory), manifest)
                path.write_bytes(b"x" * len(body))
                with self.assertRaises(SpeechError) as error:
                    verify_assets(directory)
                self.assertEqual(error.exception.code, "LOCAL_SPEECH_ASSETS_INVALID")
                path.unlink()
                path.symlink_to(directory / "absent.bin")
                with self.assertRaises(SpeechError):
                    verify_assets(directory)

    def test_manifest_only_fixed_revision_https_assets(self):
        manifest = json.loads(Path(__file__).resolve().parents[1].joinpath("assets.json").read_text())
        self.assertEqual(manifest["revision"], "f3ff3571791e39611d31c381e3a41a3af07b4987")
        self.assertLess(sum(asset.get("size", asset.get("maxBytes", 0)) for asset in manifest["assets"]), 1024 ** 3)
        for asset in manifest["assets"]:
            self.assertEqual(len(asset["sha256"]), 64)
            self.assertTrue(asset["url"].startswith("https://"))
            self.assertFalse(Path(asset["file"]).is_absolute())
            self.assertNotIn("..", Path(asset["file"]).parts)


if __name__ == "__main__":
    unittest.main()
