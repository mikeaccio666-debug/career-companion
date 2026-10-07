#!/usr/bin/env python3
"""Offline preparation of private, self-recorded voice-training candidates.

No network, provider API, playback, recording, transcript output or training.
PCM measurements describe samples; they do not establish voice identity or quality.
"""
from __future__ import annotations

import argparse
import array
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
import uuid

WORKSPACE = Path(__file__).resolve().parents[2]
SCHEMA_VERSION = 1
ANALYSIS_VERSION = 1
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_REVIEW_BYTES = 8 * 1024 * 1024
MAX_CLIPS = 2000
MAX_WAV_BYTES = 1024 * 1024 * 1024
MAX_DURATION_SECONDS = 3600
MAX_DATASET_SECONDS = 12 * 3600
SILENCE_DBFS = -50
CLIPPING_ERROR_RATIO = 0.001
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
HELDOUT_PHRASE = re.compile(r"^(?:zh|en)-t(?:0[1-9]|1[0-9]|2[0-4])$", re.I)
SPLITS = {"probe", "train", "holdout_reference", "evaluation"}
LANGUAGES = {"zh", "en", "mixed"}
PCM_GUID = bytes.fromhex("0100000000001000800000aa00389b71")


class DatasetError(Exception):
    """Only a fixed code is exposed to the console; private exceptions stay private."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _protected(info: os.stat_result, directory: bool = False) -> None:
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise DatasetError("PRIVATE_PERMISSIONS_REQUIRED")


def private_location(path: Path) -> Path:
    """Repository inputs/outputs may only be under its ignored private directories."""
    absolute = Path(os.path.abspath(path))
    # Reject user-specified symlinks, including a symlink in an existing parent.
    # System /var -> /private/var on macOS is accepted only as a canonical ancestor.
    canonical_parent = absolute.parent.resolve()
    if absolute.is_symlink():
        raise DatasetError("SYMLINK_FORBIDDEN")
    current = absolute.parent
    while current != current.parent:
        if current.is_symlink() and not (sys.platform == "darwin" and current == Path("/var")):
            raise DatasetError("SYMLINK_FORBIDDEN")
        current = current.parent
    target = canonical_parent / absolute.name
    try:
        relative = target.relative_to(WORKSPACE)
    except ValueError:
        ancestor = target.parent
        while ancestor != ancestor.parent:
            if (ancestor / ".git").exists() or (ancestor / ".git").is_symlink():
                raise DatasetError("OTHER_REPOSITORY_FORBIDDEN")
            ancestor = ancestor.parent
        return target
    if not relative.parts or relative.parts[0] not in {".local", "private"}:
        raise DatasetError("PRIVATE_LOCATION_REQUIRED")
    return target


def private_root(path: Path) -> Path:
    root = private_location(path)
    try:
        _protected(root.lstat(), directory=True)
    except OSError:
        raise DatasetError("PRIVATE_ROOT_UNAVAILABLE") from None
    return root


def create_output(path: Path) -> Path:
    target = private_location(path)
    # mkdir is exclusive for the final directory; existing reviews are never replaced.
    try:
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.mkdir(mode=0o700)
        _protected(target.lstat(), directory=True)
    except FileExistsError:
        raise DatasetError("OUTPUT_ALREADY_EXISTS") from None
    except OSError:
        raise DatasetError("OUTPUT_UNAVAILABLE") from None
    return target


def write_private(path: Path, value: object) -> str:
    data = canonical(value) + b"\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return hashlib.sha256(data).hexdigest()


def read_private(path: Path, max_bytes: int = MAX_MANIFEST_BYTES) -> bytes:
    target = private_location(path)
    try:
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            _protected(os.fstat(stream.fileno()))
            data = stream.read(max_bytes + 1)
    except OSError:
        raise DatasetError("PRIVATE_FILE_UNAVAILABLE") from None
    if len(data) > max_bytes:
        raise DatasetError("MANIFEST_TOO_LARGE")
    return data


def parse_json(data: bytes) -> dict:
    def no_duplicates(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise DatasetError("DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    def no_nonfinite(_value):
        raise DatasetError("NONFINITE_JSON_NUMBER")

    try:
        value = json.loads(data, object_pairs_hook=no_duplicates, parse_constant=no_nonfinite)
    except (UnicodeError, ValueError, RecursionError):
        raise DatasetError("INVALID_JSON") from None
    if not isinstance(value, dict):
        raise DatasetError("INVALID_MANIFEST")
    return value


def identifier(value: object) -> bool:
    return isinstance(value, str) and ID.fullmatch(value) is not None


def numeric(value: object) -> bool:
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def issue(code: str, clip_id: str | None = None, severity: str = "error") -> dict:
    # Never include exception messages, private text or arbitrary metadata in problems.
    return {"code": code, "severity": severity, **({"clip_id": clip_id} if clip_id else {})}


def check_manifest(value: dict) -> None:
    top_fields = {"schema_version", "dataset_version", "delivery_style", "speaker", "clips"}
    if set(value) - top_fields or type(value.get("schema_version")) is not int or value.get("schema_version") != SCHEMA_VERSION or not identifier(value.get("dataset_version")) or not identifier(value.get("delivery_style")):
        raise DatasetError("INVALID_MANIFEST")
    speaker = value.get("speaker")
    fields = {"speaker_id", "voice_source", "self_attested", "permitted_use", "attested_at"}
    if not isinstance(speaker, dict) or set(speaker) != fields or not identifier(speaker.get("speaker_id")) or not isinstance(speaker.get("self_attested"), bool):
        raise DatasetError("INVALID_SPEAKER_DECLARATION")
    if speaker.get("voice_source") != "self_recorded" or speaker.get("permitted_use") != "personal_voice_training":
        raise DatasetError("ONLY_SELF_RECORDED_VOICE_SUPPORTED")
    try:
        date = dt.datetime.fromisoformat(speaker["attested_at"].replace("Z", "+00:00"))
        if date.tzinfo is None or date.utcoffset() != dt.timedelta(0):
            raise ValueError()
    except (TypeError, ValueError, AttributeError):
        raise DatasetError("INVALID_ATTESTATION_DATE") from None
    if not isinstance(value.get("clips"), list) or len(value["clips"]) > MAX_CLIPS:
        raise DatasetError("INVALID_CLIP_LIST")


def check_clip(clip: object) -> dict:
    required = {"clip_id", "relative_path", "phrase_id", "language", "style", "split", "quality_status", "transcript_review"}
    optional = {"sha256", "usable_seconds", "target_locale", "script_id", "take", "duration_seconds", "sample_rate", "bit_depth", "channels", "session_id", "device_profile", "delivery_profile", "transcript", "rejection_reason", "upload_status", "training_status"}
    if not isinstance(clip, dict) or not required <= set(clip) or set(clip) - required - optional:
        raise DatasetError("INVALID_CLIP_RECORD")
    if any(not identifier(clip.get(key)) for key in ("clip_id", "phrase_id", "style")):
        raise DatasetError("INVALID_CLIP_IDENTIFIER")
    if any(not isinstance(clip[key], str) for key in ("split", "language", "quality_status", "transcript_review")) or clip["split"] not in SPLITS or clip["language"] not in LANGUAGES or clip["quality_status"] not in {"pending", "accepted", "rerecord", "rejected"} or clip["transcript_review"] not in {"pending", "reviewed"}:
        raise DatasetError("INVALID_CLIP_CLASSIFICATION")
    relative = clip["relative_path"]
    if not isinstance(relative, str) or not relative or len(relative) > 1024 or "\\" in relative or ":" in relative or relative.startswith("/") or any(part in {"", ".", ".."} for part in relative.split("/")) or PurePosixPath(relative).suffix.lower() != ".wav":
        raise DatasetError("INVALID_RELATIVE_WAV_PATH")
    if "sha256" in clip and (not isinstance(clip["sha256"], str) or not SHA.fullmatch(clip["sha256"])):
        raise DatasetError("INVALID_DECLARED_HASH")
    for field in ("usable_seconds", "duration_seconds", "sample_rate", "bit_depth", "channels", "take"):
        if field in clip and (not numeric(clip[field]) or clip[field] < 0):
            raise DatasetError("INVALID_DECLARED_AUDIO_METADATA")
    for field in optional - {"sha256", "usable_seconds", "duration_seconds", "sample_rate", "bit_depth", "channels", "take"}:
        if field in clip and (not isinstance(clip[field], str) or len(clip[field]) > 32768):
            raise DatasetError("INVALID_PRIVATE_METADATA")
    return clip


def open_wav(root: Path, relative: str):
    """Use anchored no-follow directory descriptors, rather than resolve-then-open."""
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = relative.split("/")
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        info = os.fstat(fd)
        _protected(info)
        if info.st_size < 44 or info.st_size > MAX_WAV_BYTES:
            raise DatasetError("WAV_SIZE_OUT_OF_BOUNDS")
        return os.fdopen(fd, "rb"), info
    except Exception:
        os.close(fd)
        raise


def wav_layout(stream, size: int) -> tuple[int, int, int, int, int]:
    header = stream.read(12)
    if header[:4] != b"RIFF" or header[8:] != b"WAVE" or struct.unpack("<I", header[4:8])[0] + 8 != size:
        raise DatasetError("INVALID_WAV_HEADER")
    fmt = None
    data = None
    offset = 12
    while offset < size:
        if offset + 8 > size:
            raise DatasetError("TRUNCATED_WAV")
        stream.seek(offset)
        kind, length = struct.unpack("<4sI", stream.read(8))
        body = offset + 8
        end = body + length
        if end + (length % 2) > size:
            raise DatasetError("TRUNCATED_WAV")
        if kind == b"fmt ":
            if fmt is not None or length < 16 or length > 1024:
                raise DatasetError("INVALID_WAV_FORMAT")
            fmt = stream.read(length)
        elif kind == b"data":
            if data is not None:
                raise DatasetError("MULTIPLE_WAV_DATA_CHUNKS")
            data = (body, length)
        offset = end + (length % 2)
    if fmt is None or data is None:
        raise DatasetError("MISSING_WAV_CHUNK")
    tag, channels, rate, byte_rate, alignment, bits = struct.unpack("<HHIIHH", fmt[:16])
    if tag == 0xFFFE:
        if len(fmt) < 40 or struct.unpack("<H", fmt[16:18])[0] < 22 or struct.unpack("<H", fmt[18:20])[0] != bits or fmt[24:40] != PCM_GUID:
            raise DatasetError("UNSUPPORTED_WAV_ENCODING")
    elif tag != 1:
        raise DatasetError("UNSUPPORTED_WAV_ENCODING")
    if channels not in {1, 2} or bits not in {8, 16, 24, 32} or not 8000 <= rate <= 192000:
        raise DatasetError("UNSUPPORTED_WAV_FORMAT")
    if alignment != channels * (bits // 8) or byte_rate != rate * alignment or data[1] % alignment:
        raise DatasetError("INCONSISTENT_WAV_FORMAT")
    if data[1] == 0 or data[1] / alignment / rate > MAX_DURATION_SECONDS:
        raise DatasetError("WAV_DURATION_OUT_OF_BOUNDS")
    return channels, rate, bits, data[0], data[1]


def pcm_samples(data: bytes, bits: int):
    if bits == 8:
        return (value - 128 for value in data)
    if bits in {16, 32}:
        samples = array.array("h" if bits == 16 else "i")
        samples.frombytes(data)
        if sys.byteorder != "little":
            samples.byteswap()
        return iter(samples)
    return (int.from_bytes(data[index:index + 3], "little", signed=True) for index in range(0, len(data), 3))


def inspect_wav(root: Path, relative: str, remaining_duration_seconds: float | None = None) -> dict:
    try:
        stream, original = open_wav(root, relative)
        with stream:
            channels, rate, bits, data_offset, data_size = wav_layout(stream, original.st_size)
            duration = data_size / (channels * (bits // 8)) / rate
            if remaining_duration_seconds is not None and duration > remaining_duration_seconds:
                raise DatasetError("DATASET_DURATION_OUT_OF_BOUNDS")
            file_hash = hashlib.sha256()
            stream.seek(0)
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                file_hash.update(block)
            audio_hash = hashlib.sha256(b"voice-dataset-pcm-v1\0" + struct.pack("<HHI", channels, bits, rate))
            stream.seek(data_offset)
            remaining = data_size
            full_scale = 1 << (bits - 1)
            silence_threshold = math.floor(full_scale * 10 ** (SILENCE_DBFS / 20))
            clipped = near_silent = leading = trailing = peak = 0
            seen_nonsilent = False
            squared_sum = 0
            frame_bytes = channels * (bits // 8)
            while remaining:
                block = stream.read(min(remaining, frame_bytes * 16384))
                if not block or len(block) % frame_bytes:
                    raise DatasetError("TRUNCATED_WAV")
                remaining -= len(block)
                audio_hash.update(block)
                samples = pcm_samples(block, bits)
                for _ in range(len(block) // frame_bytes):
                    silent = True
                    for _ in range(channels):
                        value = next(samples)
                        magnitude = abs(value)
                        peak = max(peak, magnitude)
                        squared_sum += value * value
                        clipped += int(value <= -full_scale or value >= full_scale - 1)
                        silent = silent and magnitude <= silence_threshold
                    if silent:
                        near_silent += 1
                        trailing += 1
                        if not seen_nonsilent:
                            leading += 1
                    else:
                        seen_nonsilent = True
                        trailing = 0
            after = os.fstat(stream.fileno())
            if (original.st_dev, original.st_ino, original.st_size, original.st_mtime_ns, original.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise DatasetError("WAV_CHANGED_DURING_ANALYSIS")
    except struct.error:
        raise DatasetError("TRUNCATED_WAV") from None
    except OSError:
        raise DatasetError("WAV_UNAVAILABLE_OR_SYMLINK") from None
    frames = data_size // frame_bytes
    sample_count = frames * channels
    def dbfs(amplitude):
        return round(20 * math.log10(amplitude / full_scale), 4) if amplitude else None
    return {
        "sha256": file_hash.hexdigest(), "audio_sha256": audio_hash.hexdigest(),
        "byte_size": original.st_size, "encoding": "integer_pcm", "sample_rate": rate,
        "bit_depth": bits, "channels": channels, "frame_count": frames,
        "duration_seconds": round(frames / rate, 6),
        "peak_dbfs": dbfs(peak), "rms_dbfs": dbfs(math.sqrt(squared_sum / sample_count)),
        "clipped_sample_count": clipped, "clipped_sample_ratio": round(clipped / sample_count, 8),
        "near_silence_threshold_dbfs": SILENCE_DBFS, "near_silence_frame_count": near_silent,
        "near_silence_ratio": round(near_silent / frames, 8),
        "leading_near_silence_seconds": round(leading / rate, 6),
        "trailing_near_silence_seconds": round(trailing / rate, 6),
    }


def analyze(root_path: Path, manifest_path: Path, *, duration_budget_seconds: float = MAX_DATASET_SECONDS) -> dict:
    if not numeric(duration_budget_seconds) or not 0 < duration_budget_seconds <= MAX_DATASET_SECONDS:
        raise DatasetError("INVALID_DURATION_BUDGET")
    root = private_root(root_path)
    raw = read_private(manifest_path)
    manifest = parse_json(raw)
    check_manifest(manifest)
    problems = []
    if not manifest["speaker"]["self_attested"]:
        problems.append(issue("SELF_ATTESTATION_REQUIRED"))
    rows = []
    ids = set()
    duplicate_audio = {}
    phrase_splits = {}
    transcript_splits = {}
    total_seconds = 0.0
    dataset_exhausted = False
    remaining_clip_records = 0
    for index, raw_clip in enumerate(manifest["clips"]):
        try:
            clip = check_clip(raw_clip)
        except DatasetError as error:
            problems.append(issue(error.code, f"record-{index + 1}"))
            continue
        clip_id = clip["clip_id"]
        if clip_id.casefold() in ids:
            problems.append(issue("DUPLICATE_CLIP_ID", clip_id))
        ids.add(clip_id.casefold())
        record = {key: clip[key] for key in ("clip_id", "relative_path", "phrase_id", "language", "style", "split", "quality_status", "transcript_review")}
        if "target_locale" in clip:
            record["target_locale"] = clip["target_locale"]
        record["candidate"] = False
        rows.append(record)
        phrase_splits.setdefault(clip["phrase_id"].casefold(), []).append((clip["split"], clip_id))
        if clip.get("transcript"):
            normalized = " ".join(clip["transcript"].casefold().split())
            transcript_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
            transcript_splits.setdefault(transcript_hash, []).append((clip["split"], clip_id))
        if clip["split"] in {"train", "probe"} and HELDOUT_PHRASE.fullmatch(clip["phrase_id"]):
            problems.append(issue("RESERVED_HOLDOUT_PHRASE", clip_id))
        if clip["split"] == "train" and clip["style"] != manifest["delivery_style"]:
            problems.append(issue("TRAIN_STYLE_MISMATCH", clip_id))
        try:
            actual = inspect_wav(root, clip["relative_path"], duration_budget_seconds - total_seconds)
        except DatasetError as error:
            problems.append(issue(error.code, clip_id))
            if error.code == "DATASET_DURATION_OUT_OF_BOUNDS":
                dataset_exhausted = True
                remaining_clip_records = len(manifest["clips"]) - index - 1
                break
            continue
        record["audio"] = actual
        duplicate_audio.setdefault(actual["audio_sha256"], []).append(clip_id)
        total_seconds += actual["duration_seconds"]
        for field in ("sha256", "sample_rate", "bit_depth", "channels"):
            if field in clip and clip[field] != actual[field]:
                problems.append(issue("DECLARED_AUDIO_METADATA_MISMATCH", clip_id))
        if "duration_seconds" in clip and abs(clip["duration_seconds"] - actual["duration_seconds"]) > 0.001:
            problems.append(issue("DECLARED_AUDIO_METADATA_MISMATCH", clip_id))
        usable = clip.get("usable_seconds", 0)
        record["usable_seconds"] = usable
        if usable > actual["duration_seconds"] + 0.001:
            problems.append(issue("USABLE_DURATION_EXCEEDS_FILE", clip_id))
        if actual["channels"] != 1:
            problems.append(issue("REVIEW_STEREO_RECORDING", clip_id, "warning"))
        if actual["sample_rate"] < 44100 or actual["bit_depth"] < 16:
            problems.append(issue("REVIEW_LOW_RESOLUTION_RECORDING", clip_id, "warning"))
        if clip["split"] == "train":
            if actual["clipped_sample_ratio"] >= CLIPPING_ERROR_RATIO:
                problems.append(issue("EXCESSIVE_PCM_CLIPPING", clip_id))
            elif actual["clipped_sample_count"]:
                problems.append(issue("REVIEW_PCM_CLIPPING", clip_id, "warning"))
            if actual["near_silence_ratio"] >= 0.99:
                problems.append(issue("TRAIN_RECORDING_NEAR_SILENT", clip_id))
            elif actual["near_silence_ratio"] >= 0.5:
                problems.append(issue("REVIEW_LONG_SILENCE", clip_id, "warning"))
            if clip["quality_status"] == "accepted" and clip["transcript_review"] == "reviewed" and usable > 0:
                record["candidate"] = True
            else:
                problems.append(issue("MANUAL_TRAIN_REVIEW_PENDING", clip_id, "warning"))
    for duplicate_ids in duplicate_audio.values():
        if len(duplicate_ids) > 1:
            problems.extend(issue("DUPLICATE_AUDIO_CONTENT", name) for name in duplicate_ids)
    for groups, code in ((phrase_splits, "TRAIN_HOLDOUT_PHRASE_OVERLAP"), (transcript_splits, "TRAIN_HOLDOUT_TRANSCRIPT_OVERLAP")):
        for entries in groups.values():
            splits = {split for split, _ in entries}
            if "train" in splits and "holdout_reference" in splits:
                problems.extend(issue(code, name) for _, name in entries)
    errors = sum(item["severity"] == "error" for item in problems)
    if errors:
        for record in rows:
            record["candidate"] = False
    candidates = sum(record["candidate"] for record in rows)
    if not candidates:
        problems.append(issue("NO_REVIEWED_TRAIN_CANDIDATES", severity="warning"))
    return {
        "schema_version": SCHEMA_VERSION, "analysis_version": ANALYSIS_VERSION,
        "manifest_sha256": hashlib.sha256(raw).hexdigest(),
        "root_fingerprint": hashlib.sha256(str(root).encode("utf-8")).hexdigest(),
        "dataset_version": manifest["dataset_version"], "delivery_style": manifest["delivery_style"],
        "self_recorded_declaration": manifest["speaker"]["self_attested"],
        "declaration_is_not_identity_or_legal_verification": True,
        "automatic_voice_similarity_or_language_quality_assessment": False,
        "ok": errors == 0, "export_ready": errors == 0 and candidates > 0,
        "clip_count": len(manifest["clips"]), "candidate_count": candidates,
        "analysis_complete": not dataset_exhausted, "unanalyzed_clip_records": remaining_clip_records,
        "analyzed_clip_count": sum("audio" in record for record in rows),
        "analyzed_duration_seconds": round(total_seconds, 6), "issues": problems, "clips": rows,
    }


def validate(root: Path, manifest: Path, output: Path) -> dict:
    snapshot = analyze(root, manifest)
    destination = create_output(output)
    digest = write_private(destination / "review.json", {"created_at": utc_now(), "snapshot": snapshot})
    return {
        "ok": snapshot["ok"], "export_ready": snapshot["export_ready"],
        "clip_count": snapshot["clip_count"], "candidate_count": snapshot["candidate_count"],
        "errors": sum(item["severity"] == "error" for item in snapshot["issues"]),
        "warnings": sum(item["severity"] == "warning" for item in snapshot["issues"]),
        "report_file": "review.json", "report_sha256": digest,
    }


def export_candidates(root: Path, manifest: Path, review_path: Path, review_hash: str, confirmed: bool, output: Path) -> dict:
    if not confirmed or not SHA.fullmatch(review_hash):
        raise DatasetError("EXPLICIT_REVIEW_REQUIRED")
    review_raw = read_private(review_path, MAX_REVIEW_BYTES)
    if hashlib.sha256(review_raw).hexdigest() != review_hash:
        raise DatasetError("REVIEW_HASH_MISMATCH")
    review = parse_json(review_raw)
    current = analyze(root, manifest)
    if review.get("snapshot") != current:
        raise DatasetError("DATASET_CHANGED_SINCE_REVIEW")
    if not current["export_ready"]:
        raise DatasetError("DATASET_NOT_READY_FOR_EXPORT")
    groups = {language: [] for language in sorted(LANGUAGES)}
    for clip in current["clips"]:
        if clip["candidate"]:
            groups[clip["language"]].append(clip)
    totals = {language: {"clips": len(clips), "usable_seconds": round(sum(clip["usable_seconds"] for clip in clips), 6)} for language, clips in groups.items()}
    export = {
        "schema_version": SCHEMA_VERSION, "kind": "reviewed_personal_voice_training_candidates",
        "status": "prepared_not_uploaded", "created_at": utc_now(),
        "dataset_version": current["dataset_version"], "delivery_style": current["delivery_style"],
        "source_manifest_sha256": current["manifest_sha256"], "review_report_sha256": review_hash,
        "self_recorded_declaration": True, "declaration_is_not_identity_or_legal_verification": True,
        "automatic_voice_similarity_or_language_quality_assessment": False,
        "audio_copied": False, "uploaded": False, "training_started": False,
        "groups": groups, "totals": totals,
    }
    destination = create_output(output)
    digest = write_private(destination / "candidate-manifest.json", export)
    return {"ok": True, "candidate_count": current["candidate_count"], "export_file": "candidate-manifest.json", "export_sha256": digest, "audio_copied": False, "uploaded": False, "training_started": False}


def init_dataset(root: Path) -> dict:
    target = create_output(root)
    for directory in ("masters", "probe", "train/zh", "train/en", "train/mixed", "holdout/reference", "evaluation", "manifests"):
        current = target
        for part in directory.split("/"):
            current = current / part
            current.mkdir(mode=0o700, exist_ok=True)
            _protected(current.lstat(), directory=True)
    manifest = {
        "schema_version": SCHEMA_VERSION, "dataset_version": "v001", "delivery_style": "natural-warm",
        "speaker": {"speaker_id": "self", "voice_source": "self_recorded", "self_attested": False, "permitted_use": "personal_voice_training", "attested_at": utc_now()},
        "clips": [],
    }
    digest = write_private(target / "manifests" / "dataset.json", manifest)
    return {"ok": True, "manifest_file": "manifests/dataset.json", "manifest_sha256": digest, "clips": 0, "self_attested": False}


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline private self-recorded PCM WAV preparation. No upload or training.")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Create an exclusive private recording directory and empty manifest")
    init.add_argument("--root", type=Path, required=True)
    for name in ("validate", "export"):
        command = commands.add_parser(name)
        command.add_argument("--root", type=Path, required=True)
        command.add_argument("--manifest", type=Path, required=True)
        command.add_argument("--output", type=Path, help="New private directory; default is an ignored .local directory")
        if name == "export":
            command.add_argument("--review-report", type=Path, required=True)
            command.add_argument("--review-sha256", required=True)
            command.add_argument("--confirm-reviewed", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "init":
            result = init_dataset(args.root)
        else:
            output = args.output or WORKSPACE / ".local" / "voice-dataset" / f"{args.command}-{uuid.uuid4().hex}"
            if args.command == "validate":
                result = validate(args.root, args.manifest, output)
            else:
                result = export_candidates(args.root, args.manifest, args.review_report, args.review_sha256, args.confirm_reviewed, output)
            if args.output is None:
                result["output_directory"] = output.relative_to(WORKSPACE).as_posix()
        print(json.dumps(result, sort_keys=True))
        return 0 if result["ok"] else 1
    except DatasetError as error:
        print(json.dumps({"ok": False, "code": error.code}, sort_keys=True))
        return 1
    except (OSError, ValueError, TypeError, OverflowError):
        print(json.dumps({"ok": False, "code": "LOCAL_OPERATION_FAILED"}, sort_keys=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
