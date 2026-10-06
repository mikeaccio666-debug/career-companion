"""CPU Kokoro with explicit verified local files. Import only inside the isolated child."""
import base64
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import socket
import wave

from protocol import MAX_WAV_BYTES, SAMPLE_RATE, SpeechError


def block_network() -> None:
    def denied(*_args, **_kwargs):
        raise RuntimeError("NETWORK_DISABLED")
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied


def verify_assets(directory: Path) -> dict:
    manifest = json.loads(Path(__file__).with_name("assets.json").read_text())
    if directory.is_symlink() or not directory.is_dir():
        raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
    for asset in manifest["assets"]:
        path = directory / asset["file"]
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(directory.resolve()):
            raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
        h = hashlib.sha256()
        size = 0
        with path.open("rb") as source:
            for data in iter(lambda: source.read(1024 * 1024), b""):
                size += len(data)
                if size > asset.get("size", asset.get("maxBytes", 0)):
                    raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
                h.update(data)
        if ("size" in asset and size != asset["size"]) or h.hexdigest() != asset["sha256"]:
            raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
    # The preinstalled G2P data/library must agree with the installed wheel's RECORD.
    for name, version in [("en-core-web-sm", "3.8.0"), ("misaki", "0.9.4"), ("espeakng-loader", "0.2.4")]:
        distribution = importlib.metadata.distribution(name)
        if distribution.version != version:
            raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
        for entry in distribution.files or []:
            if entry.hash is None:
                continue
            path = distribution.locate_file(entry)
            if entry.hash.mode != "sha256" or not path.is_file():
                raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
            h = hashlib.sha256()
            with path.open("rb") as source:
                for data in iter(lambda: source.read(1024 * 1024), b""):
                    h.update(data)
            if base64.urlsafe_b64encode(h.digest()).rstrip(b"=").decode() != entry.hash.value:
                raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
    return manifest


class Engine:
    def __init__(self, directory: Path):
        block_network()
        self.manifest = verify_assets(directory)
        from loguru import logger
        logger.remove()
        import numpy as np
        import spacy
        import torch
        from kokoro import KModel, KPipeline
        if not spacy.util.is_package("en_core_web_sm"):
            raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        model = KModel(repo_id="hexgrad/Kokoro-82M", config=str(directory / "config.json"),
                       model=str(directory / "kokoro-v1_0.pth")).to("cpu").eval()
        self.voice = torch.load(directory / "voices/af_heart.pt", map_location="cpu", weights_only=True)
        if not isinstance(self.voice, torch.Tensor) or self.voice.ndim != 3 or self.voice.shape[0] < 510 or self.voice.shape[-1] != 256:
            raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
        self.pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=model)
        if self.pipeline.g2p.fallback is None:
            raise SpeechError("LOCAL_SPEECH_ASSETS_INVALID", 503)
        self.np = np

    def synthesize(self, text: str) -> bytes:
        chunks = []
        samples = 0
        for result in self.pipeline(text, voice=self.voice):
            if result.audio is None:
                raise SpeechError("LOCAL_SPEECH_FAILED", 502)
            chunk = result.audio.numpy()
            if chunk.ndim != 1 or not self.np.isfinite(chunk).all():
                raise SpeechError("LOCAL_SPEECH_FAILED", 502)
            samples += len(chunk)
            if samples * 2 + 44 > MAX_WAV_BYTES:
                raise SpeechError("LOCAL_SPEECH_OUTPUT_LIMIT", 413)
            chunks.append(chunk)
        if not samples:
            raise SpeechError("LOCAL_SPEECH_FAILED", 502)
        audio = self.np.concatenate(chunks)
        pcm = (self.np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        output = io.BytesIO()
        with wave.open(output, "wb") as destination:
            destination.setnchannels(1)
            destination.setsampwidth(2)
            destination.setframerate(SAMPLE_RATE)
            destination.writeframes(pcm)
        return output.getvalue()
