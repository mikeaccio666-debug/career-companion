"""Verified local tiny model, bounded PyAV decoding and local Silero VAD."""
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import socket

from protocol import MAX_AUDIO_BYTES, MAX_DURATION_SECONDS, MAX_TEXT_BYTES, SAMPLE_RATE, TranscriptionError, result_bytes


def block_network():
    def denied(*_args, **_kwargs):
        raise RuntimeError("NETWORK_DISABLED")
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied


def checked_file(path, expected):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != expected["size"]:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_ASSETS_INVALID", 503)
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected["sha256"]:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_ASSETS_INVALID", 503)


def verify_assets(directory):
    manifest = json.loads(Path(__file__).with_name("assets.json").read_text())
    if directory.is_symlink() or not directory.is_dir():
        raise TranscriptionError("LOCAL_TRANSCRIPTION_ASSETS_INVALID", 503)
    for asset in manifest["assets"]:
        path = directory / asset["file"]
        if not path.resolve().is_relative_to(directory.resolve()):
            raise TranscriptionError("LOCAL_TRANSCRIPTION_ASSETS_INVALID", 503)
        checked_file(path, asset)
    vad = manifest["packagedVAD"]
    distribution = importlib.metadata.distribution(vad["distribution"])
    if distribution.version != vad["version"] or not vad["files"]:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_ASSETS_INVALID", 503)
    for asset in vad["files"]:
        checked_file(Path(distribution.locate_file(asset["file"])), asset)
    return manifest


def decode_audio(data):
    """Reject overlong audio while iterating frames, before full PCM accumulation."""
    import av
    import numpy as np
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_BODY_TOO_LARGE", 413)
    chunks = []
    samples = 0
    try:
        # Custom in-memory AVIO only; no caller URL/path or secondary file/network protocols.
        with av.open(io.BytesIO(data), mode="r", options={"protocol_whitelist": "pipe",
                     "format_whitelist": "wav,mp3,mov,matroska,ogg,flac"}) as container:
            if len(container.streams.audio) != 1 or container.streams.video:
                raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_AUDIO")
            resampler = av.audio.resampler.AudioResampler(format="fltp", layout="mono", rate=SAMPLE_RATE)

            def consume(frame):
                nonlocal samples
                audio = frame.to_ndarray().reshape(-1)
                samples += len(audio)
                if samples > SAMPLE_RATE * MAX_DURATION_SECONDS:
                    raise TranscriptionError("LOCAL_TRANSCRIPTION_DURATION_LIMIT", 413)
                if not np.isfinite(audio).all():
                    raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_AUDIO")
                chunks.append(audio.copy())

            for frame in container.decode(container.streams.audio[0]):
                if not 8000 <= frame.sample_rate <= 192000 or not 1 <= len(frame.layout.channels) <= 2:
                    raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_AUDIO")
                frame.pts = None
                for converted in resampler.resample(frame):
                    consume(converted)
            for converted in resampler.resample(None):
                consume(converted)
    except TranscriptionError:
        raise
    except Exception:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_AUDIO") from None
    if not samples:
        raise TranscriptionError("LOCAL_TRANSCRIPTION_INVALID_AUDIO")
    return np.concatenate(chunks).astype(np.float32, copy=False)


class Engine:
    def __init__(self, directory):
        block_network()
        self.manifest = verify_assets(directory)
        from faster_whisper import WhisperModel
        from faster_whisper.vad import get_vad_model
        self.model = WhisperModel(str(directory), device="cpu", compute_type="int8", cpu_threads=4,
                                  num_workers=1, local_files_only=True)
        self.vad = get_vad_model()  # Preload the hash-checked packaged ONNX, not first-request download.

    def transcribe(self, data):
        audio = decode_audio(data)
        segments, _info = self.model.transcribe(audio, task="transcribe", beam_size=5,
            condition_on_previous_text=False, vad_filter=True, temperature=0,
            vad_parameters={"min_silence_duration_ms": 500}, log_progress=False)
        pieces = []
        size = 0
        for segment in segments:  # Inference is lazy; consume fully before returning.
            size += len(segment.text.encode("utf-8"))
            if size > MAX_TEXT_BYTES:
                raise TranscriptionError("LOCAL_TRANSCRIPTION_OUTPUT_LIMIT", 413)
            pieces.append(segment.text)
        result = {"text": "".join(pieces).strip()}
        result_bytes(result)
        return result
