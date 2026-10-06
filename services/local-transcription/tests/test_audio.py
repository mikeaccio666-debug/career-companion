import hashlib
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import decode_audio, verify_assets
from protocol import MAX_TEXT_BYTES, TranscriptionError, result_bytes


def wav(seconds=1, rate=24000, channels=1):
    destination = io.BytesIO()
    with wave.open(destination, "wb") as source:
        source.setnchannels(channels)
        source.setsampwidth(2)
        source.setframerate(rate)
        source.writeframes(b"\x01\x00" * int(seconds * rate) * channels)
    return destination.getvalue()


class AudioTests(unittest.TestCase):
    def test_real_decode_resamples_stereo_and_enforces_sample_duration(self):
        data = decode_audio(wav(1, 48000, 2))
        self.assertEqual(data.shape, (16000,))
        self.assertEqual(str(data.dtype), "float32")
        with self.assertRaises(TranscriptionError) as long:
            decode_audio(wav(121, 16000))
        self.assertEqual(long.exception.code, "LOCAL_TRANSCRIPTION_DURATION_LIMIT")

    def test_fake_audio_and_secondary_protocol_playlist_rejected(self):
        with self.assertRaises(TranscriptionError):
            decode_audio(b"not an actual audio container")
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(0.05)
        try:
            malicious = f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:{listener.getsockname()[1]}/audio.ts\n#EXT-X-ENDLIST\n".encode()
            with self.assertRaises(TranscriptionError):
                decode_audio(malicious)
            with self.assertRaises(TimeoutError):
                listener.accept()
        finally:
            listener.close()

    def test_empty_transcript_utf8_and_json_escape_budgets(self):
        self.assertEqual(result_bytes({"text": ""}), b'{"text":""}')
        result_bytes({"text": "中" * (MAX_TEXT_BYTES // 3)})
        for value in [{"text": "中" * (MAX_TEXT_BYTES // 3 + 1)}, {"text": "\x00" * MAX_TEXT_BYTES},
                      {"text": "\ud800"}, {"text": "synthetic", "metadata": "unapproved"}]:
            with self.assertRaises(TranscriptionError):
                result_bytes(value)

    def test_same_size_asset_change_and_vad_hash_rejected(self):
        with tempfile.TemporaryDirectory(prefix="synthetic-transcription-assets-") as temporary:
            directory = Path(temporary)
            body = b"synthetic fixed weight"
            (directory / "model.bin").write_bytes(body)
            expected = {"file": "model.bin", "size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
            manifest = {"assets": [expected], "packagedVAD": {"distribution": "faster-whisper", "version": "1.2.1", "files": [expected]}}

            class Distribution:
                version = "1.2.1"

                def locate_file(self, name):
                    return directory / name

            with patch("engine.json.loads", return_value=manifest), patch("engine.importlib.metadata.distribution", return_value=Distribution()):
                self.assertEqual(verify_assets(directory), manifest)
                (directory / "model.bin").write_bytes(b"x" * len(body))
                with self.assertRaises(TranscriptionError) as changed:
                    verify_assets(directory)
                self.assertEqual(changed.exception.code, "LOCAL_TRANSCRIPTION_ASSETS_INVALID")


if __name__ == "__main__":
    unittest.main()
