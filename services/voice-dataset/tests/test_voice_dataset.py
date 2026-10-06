"""All audio is generated PCM, not a person's voice. No provider or network calls."""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import wave

MODULE_PATH = Path(__file__).resolve().parents[1] / "voice_dataset.py"
spec = importlib.util.spec_from_file_location("voice_dataset", MODULE_PATH)
dataset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dataset)


class VoiceDatasetTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="synthetic-voice-dataset-")
        self.root = Path(self.temporary.name).resolve()
        os.chmod(self.root, 0o700)
        self.manifest = self.root / "dataset.json"
        self.value = {
            "schema_version": 1, "dataset_version": "synthetic-v001", "delivery_style": "natural-warm",
            "speaker": {"speaker_id": "fictional-self", "voice_source": "self_recorded", "self_attested": True, "permitted_use": "personal_voice_training", "attested_at": "2026-10-06T12:00:00Z"},
            "clips": [],
        }

    def tearDown(self):
        self.temporary.cleanup()

    def save_manifest(self):
        self.manifest.write_text(json.dumps(self.value), encoding="utf-8")
        os.chmod(self.manifest, 0o600)

    def wav(self, name="train/zh/synthetic.wav", bits=16, channels=1, rate=44100, samples=None, tone=220):
        target = self.root / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if samples is None:
            scale = 1 << (bits - 1)
            samples = [int(scale * 0.15 * math.sin(2 * math.pi * tone * frame / rate)) for frame in range(rate // 10) for _ in range(channels)]
        body = b"".join(bytes([sample + 128]) if bits == 8 else sample.to_bytes(bits // 8, "little", signed=True) for sample in samples)
        with wave.open(str(target), "wb") as writer:
            writer.setnchannels(channels)
            writer.setsampwidth(bits // 8)
            writer.setframerate(rate)
            writer.writeframes(body)
        os.chmod(target, 0o600)
        return target

    def clip(self, name="train/zh/synthetic.wav", clip_id="synth-1", phrase="ZH-B01", split="train", **fields):
        record = {"clip_id": clip_id, "relative_path": name, "phrase_id": phrase, "language": "zh", "style": "natural-warm", "split": split, "quality_status": "accepted", "transcript_review": "reviewed", "usable_seconds": 0.1}
        record.update(fields)
        self.value["clips"].append(record)
        return record

    def analyze(self):
        self.save_manifest()
        return dataset.analyze(self.root, self.manifest)

    def codes(self, snapshot):
        return {item["code"] for item in snapshot["issues"]}

    def reviewed(self):
        self.wav()
        self.clip(transcript="Fictional private sentence, excluded from all outputs.")
        self.save_manifest()
        output = self.root / "review"
        result = dataset.validate(self.root, self.manifest, output)
        return output / "review.json", result["report_sha256"]

    def test_supported_pcm_widths_and_extensible_integer_pcm(self):
        for bits in (8, 16, 24, 32):
            with self.subTest(bits=bits):
                path = self.wav(name=f"probe/{bits}.wav", bits=bits)
                audio = dataset.inspect_wav(self.root, path.relative_to(self.root).as_posix())
                self.assertEqual(audio["bit_depth"], bits)
                self.assertEqual(audio["sample_rate"], 44100)
                self.assertEqual(audio["channels"], 1)
                self.assertEqual(audio["duration_seconds"], 0.1)
                self.assertEqual(audio["clipped_sample_count"], 0)
                self.assertEqual(audio["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        path = self.wav(name="probe/extensible.wav")
        raw = path.read_bytes()
        format_chunk = struct.pack("<HHIIHHHHI", 0xFFFE, 1, 44100, 88200, 2, 16, 22, 16, 0) + dataset.PCM_GUID
        extended = raw[:12] + b"fmt " + struct.pack("<I", len(format_chunk)) + format_chunk + raw[36:]
        path.write_bytes(extended[:4] + struct.pack("<I", len(extended) - 8) + extended[8:])
        self.assertEqual(dataset.inspect_wav(self.root, "probe/extensible.wav")["encoding"], "integer_pcm")

    def test_metrics_count_samples_and_whole_silent_frames(self):
        self.wav(name="probe/metrics.wav", channels=2, rate=8000, samples=[0, 0, 32767, 0, -32768, 0, 0, 0])
        audio = dataset.inspect_wav(self.root, "probe/metrics.wav")
        self.assertEqual(audio["frame_count"], 4)
        self.assertEqual(audio["clipped_sample_count"], 2)
        self.assertEqual(audio["clipped_sample_ratio"], 0.25)
        self.assertEqual(audio["near_silence_frame_count"], 2)
        self.assertEqual(audio["near_silence_ratio"], 0.5)
        self.assertEqual(audio["leading_near_silence_seconds"], 0.000125)
        self.assertEqual(audio["trailing_near_silence_seconds"], 0.000125)
        self.assertEqual(audio["peak_dbfs"], 0)

    def test_train_clipping_and_near_silence_block_export_not_probe_diagnostics(self):
        self.wav(samples=[32767] * 4410)
        self.clip()
        result = self.analyze()
        self.assertIn("EXCESSIVE_PCM_CLIPPING", self.codes(result))
        self.assertFalse(result["export_ready"])
        self.wav(samples=[0] * 4410)
        result = self.analyze()
        self.assertIn("TRAIN_RECORDING_NEAR_SILENT", self.codes(result))
        self.value["clips"][0]["split"] = "probe"
        result = self.analyze()
        self.assertTrue(result["ok"])
        self.assertFalse(result["export_ready"])

    def test_pcm_duplicate_with_different_container_metadata_is_rejected(self):
        first = self.wav()
        second = self.root / "train/zh/second.wav"
        raw = first.read_bytes() + b"JUNK" + struct.pack("<I", 4) + b"demo"
        second.write_bytes(raw[:4] + struct.pack("<I", len(raw) - 8) + raw[8:])
        os.chmod(second, 0o600)
        self.clip()
        self.clip(name="train/zh/second.wav", clip_id="synth-2", phrase="ZH-B02")
        result = self.analyze()
        self.assertIn("DUPLICATE_AUDIO_CONTENT", self.codes(result))
        self.assertNotEqual(result["clips"][0]["audio"]["sha256"], result["clips"][1]["audio"]["sha256"])
        self.assertEqual(result["candidate_count"], 0)

    def test_train_holdout_phrase_overlap_is_case_insensitive(self):
        self.wav()
        self.wav(name="holdout/reference/different.wav", tone=330)
        self.clip(phrase="custom-phrase")
        self.clip(name="holdout/reference/different.wav", clip_id="synth-2", phrase="CUSTOM-PHRASE", split="holdout_reference")
        result = self.analyze()
        self.assertIn("TRAIN_HOLDOUT_PHRASE_OVERLAP", self.codes(result))
        self.assertFalse(result["export_ready"])

    def test_train_holdout_same_private_transcript_is_rejected_with_different_ids(self):
        self.wav()
        self.wav(name="holdout/reference/different.wav", tone=330)
        self.clip(transcript=" Synthetic   sentence ")
        self.clip(name="holdout/reference/different.wav", clip_id="synth-2", phrase="other-phrase", split="holdout_reference", transcript="synthetic sentence")
        result = self.analyze()
        self.assertIn("TRAIN_HOLDOUT_TRANSCRIPT_OVERLAP", self.codes(result))
        self.assertNotIn("Synthetic", json.dumps(result))

    def test_reserved_manual_holdout_ids_never_enter_train_or_probe(self):
        self.wav()
        clip = self.clip(phrase="EN-T24")
        for split in ("train", "probe"):
            with self.subTest(split=split):
                clip["split"] = split
                self.assertIn("RESERVED_HOLDOUT_PHRASE", self.codes(self.analyze()))
        clip["split"] = "holdout_reference"
        self.assertTrue(self.analyze()["ok"])

    def test_only_manually_reviewed_accepted_train_is_candidate(self):
        self.wav()
        clip = self.clip()
        for field, value in (("quality_status", "pending"), ("transcript_review", "pending"), ("usable_seconds", 0), ("split", "probe"), ("split", "holdout_reference"), ("split", "evaluation")):
            with self.subTest(field=field, value=value):
                prior = clip[field]
                clip[field] = value
                result = self.analyze()
                self.assertTrue(result["ok"])
                self.assertFalse(result["export_ready"])
                clip[field] = prior
        self.assertTrue(self.analyze()["export_ready"])

    def test_false_self_attestation_is_not_silently_granted(self):
        self.wav()
        self.clip()
        self.value["speaker"]["self_attested"] = False
        result = self.analyze()
        self.assertIn("SELF_ATTESTATION_REQUIRED", self.codes(result))
        self.assertEqual(result["candidate_count"], 0)
        self.assertTrue(result["declaration_is_not_identity_or_legal_verification"])

    def test_other_speaker_source_or_use_is_rejected(self):
        for field, value in (("voice_source", "other_person"), ("permitted_use", "unrestricted")):
            with self.subTest(field=field):
                prior = self.value["speaker"][field]
                self.value["speaker"][field] = value
                with self.assertRaisesRegex(dataset.DatasetError, "ONLY_SELF_RECORDED_VOICE_SUPPORTED"):
                    self.analyze()
                self.value["speaker"][field] = prior

    def test_stable_training_style_and_declared_metadata_are_checked(self):
        self.wav()
        self.clip(style="advertisement", sha256="0" * 64, channels=2, usable_seconds=0.2)
        codes = self.codes(self.analyze())
        self.assertTrue({"TRAIN_STYLE_MISMATCH", "DECLARED_AUDIO_METADATA_MISMATCH", "USABLE_DURATION_EXCEEDS_FILE"} <= codes)

    def test_id_and_duplicate_json_key_validation(self):
        self.wav()
        self.clip()
        self.clip(clip_id="SYNTH-1", phrase="ZH-B02")
        self.assertIn("DUPLICATE_CLIP_ID", self.codes(self.analyze()))
        with self.assertRaisesRegex(dataset.DatasetError, "DUPLICATE_JSON_KEY"):
            dataset.parse_json(b'{"schema_version":1,"schema_version":1}')
        self.value["schema_version"] = True
        with self.assertRaisesRegex(dataset.DatasetError, "INVALID_MANIFEST"):
            self.analyze()

    def test_private_path_traversal_and_absolute_paths_rejected(self):
        for relative in ("../escape.wav", "/tmp/escape.wav", "train//escape.wav", "train/./escape.wav", "C:\\escape.wav", "train/../escape.wav", "file.mp3"):
            with self.subTest(relative=relative):
                self.value["clips"] = []
                self.clip(name=relative)
                self.assertIn("INVALID_RELATIVE_WAV_PATH", self.codes(self.analyze()))

    def test_file_and_directory_symlinks_are_never_followed(self):
        target = self.wav(name="probe/real.wav")
        (self.root / "alias.wav").symlink_to(target)
        (self.root / "alias-dir").symlink_to(target.parent, target_is_directory=True)
        for name in ("alias.wav", "alias-dir/real.wav"):
            with self.subTest(name=name):
                self.value["clips"] = []
                self.clip(name=name)
                self.assertIn("WAV_UNAVAILABLE_OR_SYMLINK", self.codes(self.analyze()))

    def test_manifest_and_root_symlinks_rejected(self):
        self.save_manifest()
        alias = self.root / "alias.json"
        alias.symlink_to(self.manifest)
        with self.assertRaisesRegex(dataset.DatasetError, "SYMLINK_FORBIDDEN"):
            dataset.analyze(self.root, alias)
        alias_root = self.root / "root-alias"
        alias_root.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(dataset.DatasetError, "SYMLINK_FORBIDDEN"):
            dataset.analyze(alias_root, self.manifest)

    def test_private_permissions_required_for_root_manifest_and_recording(self):
        path = self.wav()
        self.clip()
        self.save_manifest()
        os.chmod(path, 0o644)
        self.assertIn("PRIVATE_PERMISSIONS_REQUIRED", self.codes(dataset.analyze(self.root, self.manifest)))
        os.chmod(path, 0o600)
        os.chmod(self.manifest, 0o644)
        with self.assertRaisesRegex(dataset.DatasetError, "PRIVATE_PERMISSIONS_REQUIRED"):
            dataset.analyze(self.root, self.manifest)
        os.chmod(self.manifest, 0o600)
        os.chmod(self.root, 0o755)
        with self.assertRaisesRegex(dataset.DatasetError, "PRIVATE_PERMISSIONS_REQUIRED"):
            dataset.analyze(self.root, self.manifest)
        os.chmod(self.root, 0o700)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO checks require a POSIX filesystem")
    def test_fifo_manifest_and_wav_are_rejected_without_waiting_for_writer(self):
        fifo = self.root / "fifo.json"
        os.mkfifo(fifo, 0o600)
        result = subprocess.run([sys.executable, str(MODULE_PATH), "validate", "--root", str(self.root), "--manifest", str(fifo), "--output", str(self.root / "fifo-manifest-review")], capture_output=True, text=True, check=False, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["code"], "PRIVATE_PERMISSIONS_REQUIRED")
        os.mkfifo(self.root / "fifo.wav", 0o600)
        self.clip(name="fifo.wav")
        self.save_manifest()
        result = subprocess.run([sys.executable, str(MODULE_PATH), "validate", "--root", str(self.root), "--manifest", str(self.manifest), "--output", str(self.root / "fifo-wav-review")], capture_output=True, text=True, check=False, timeout=3)
        self.assertEqual(result.returncode, 1)
        review = json.loads((self.root / "fifo-wav-review/review.json").read_text())
        self.assertIn("PRIVATE_PERMISSIONS_REQUIRED", self.codes(review["snapshot"]))

    def test_aggregate_budget_stops_before_second_file_pcm_or_later_files(self):
        self.wav()
        self.wav(name="train/zh/second.wav", tone=330)
        self.clip()
        self.clip(name="train/zh/second.wav", clip_id="synth-2", phrase="ZH-B02")
        self.clip(name="train/zh/not-read.wav", clip_id="synth-3", phrase="ZH-B03")
        self.save_manifest()
        with mock.patch.object(dataset, "pcm_samples", wraps=dataset.pcm_samples) as samples:
            result = dataset.analyze(self.root, self.manifest, duration_budget_seconds=0.15)
        self.assertEqual(samples.call_count, 1)
        self.assertIn("DATASET_DURATION_OUT_OF_BOUNDS", self.codes(result))
        self.assertNotIn("WAV_UNAVAILABLE_OR_SYMLINK", self.codes(result))
        self.assertEqual(result["analyzed_clip_count"], 1)
        self.assertEqual(result["analyzed_duration_seconds"], 0.1)
        self.assertEqual(result["unanalyzed_clip_records"], 1)
        self.assertFalse(result["analysis_complete"])
        self.assertFalse(result["export_ready"])

    def test_malformed_truncated_and_non_pcm_wav_rejected(self):
        path = self.wav()
        original = path.read_bytes()
        mutations = {
            "bad-header": b"OggS" + original[4:],
            "truncated": original[:-2],
            "float": original[:20] + struct.pack("<H", 3) + original[22:],
            "alignment": original[:32] + struct.pack("<H", 1) + original[34:],
        }
        for name, data in mutations.items():
            with self.subTest(name=name):
                path.write_bytes(data)
                with self.assertRaises(dataset.DatasetError):
                    dataset.inspect_wav(self.root, "train/zh/synthetic.wav")

    def test_report_and_export_are_private_exclusive_and_have_no_transcript(self):
        review, digest = self.reviewed()
        self.assertEqual(stat.S_IMODE(review.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(review.parent.stat().st_mode), 0o700)
        output = self.root / "export"
        result = dataset.export_candidates(self.root, self.manifest, review, digest, True, output)
        self.assertTrue(result["ok"])
        self.assertFalse(result["uploaded"])
        self.assertFalse(result["training_started"])
        exported = json.loads((output / "candidate-manifest.json").read_text())
        self.assertEqual(len(exported["groups"]["zh"]), 1)
        self.assertEqual(exported["groups"]["en"], [])
        self.assertEqual(exported["status"], "prepared_not_uploaded")
        self.assertNotIn("Fictional private sentence", review.read_text())
        self.assertNotIn("Fictional private sentence", json.dumps(exported))
        self.assertEqual(stat.S_IMODE((output / "candidate-manifest.json").stat().st_mode), 0o600)
        self.assertEqual(list(output.iterdir()), [output / "candidate-manifest.json"])
        with self.assertRaisesRegex(dataset.DatasetError, "OUTPUT_ALREADY_EXISTS"):
            dataset.export_candidates(self.root, self.manifest, review, digest, True, output)

    def test_export_requires_review_confirmation_and_exact_hash(self):
        review, digest = self.reviewed()
        with self.assertRaisesRegex(dataset.DatasetError, "EXPLICIT_REVIEW_REQUIRED"):
            dataset.export_candidates(self.root, self.manifest, review, digest, False, self.root / "export")
        with self.assertRaisesRegex(dataset.DatasetError, "REVIEW_HASH_MISMATCH"):
            dataset.export_candidates(self.root, self.manifest, review, "0" * 64, True, self.root / "export")
        self.assertFalse((self.root / "export").exists())

    def test_audio_changed_after_review_cannot_export(self):
        review, digest = self.reviewed()
        self.wav(tone=330)
        with self.assertRaisesRegex(dataset.DatasetError, "DATASET_CHANGED_SINCE_REVIEW"):
            dataset.export_candidates(self.root, self.manifest, review, digest, True, self.root / "export")
        self.assertFalse((self.root / "export").exists())

    def test_manifest_or_derived_review_changed_cannot_export(self):
        review, digest = self.reviewed()
        self.value["clips"][0]["usable_seconds"] = 0.09
        self.save_manifest()
        with self.assertRaisesRegex(dataset.DatasetError, "DATASET_CHANGED_SINCE_REVIEW"):
            dataset.export_candidates(self.root, self.manifest, review, digest, True, self.root / "export")
        self.value["clips"][0]["usable_seconds"] = 0.1
        self.save_manifest()
        changed = json.loads(review.read_bytes())
        changed["snapshot"]["issues"] = []
        changed["snapshot"]["candidate_count"] = 5
        review.write_text(json.dumps(changed))
        digest = hashlib.sha256(review.read_bytes()).hexdigest()
        with self.assertRaisesRegex(dataset.DatasetError, "DATASET_CHANGED_SINCE_REVIEW"):
            dataset.export_candidates(self.root, self.manifest, review, digest, True, self.root / "export")

    def test_failed_validation_report_cannot_export(self):
        self.wav()
        self.clip()
        self.value["speaker"]["self_attested"] = False
        self.save_manifest()
        result = dataset.validate(self.root, self.manifest, self.root / "review")
        self.assertFalse(result["ok"])
        with self.assertRaisesRegex(dataset.DatasetError, "DATASET_NOT_READY_FOR_EXPORT"):
            dataset.export_candidates(self.root, self.manifest, self.root / "review/review.json", result["report_sha256"], True, self.root / "export")

    def test_tracked_workspace_locations_never_receive_private_outputs(self):
        with self.assertRaisesRegex(dataset.DatasetError, "PRIVATE_LOCATION_REQUIRED"):
            dataset.create_output(dataset.WORKSPACE / "services/voice-dataset/private-audio-test")
        with self.assertRaisesRegex(dataset.DatasetError, "PRIVATE_LOCATION_REQUIRED"):
            dataset.private_root(dataset.WORKSPACE / "services/voice-dataset")

    def test_other_git_repositories_are_not_private_dataset_locations(self):
        other = self.root / "other-repository"
        other.mkdir(mode=0o700)
        (other / ".git").mkdir(mode=0o700)
        with self.assertRaisesRegex(dataset.DatasetError, "OTHER_REPOSITORY_FORBIDDEN"):
            dataset.create_output(other / "recordings")

    def test_cli_init_creates_no_audio_or_self_permission(self):
        target = self.root / "new-root"
        command = [sys.executable, str(MODULE_PATH), "init", "--root", str(target)]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        console = json.loads(result.stdout)
        self.assertFalse(console["self_attested"])
        manifest = json.loads((target / "manifests/dataset.json").read_text())
        self.assertEqual(manifest["clips"], [])
        self.assertFalse(list(target.rglob("*.wav")))
        self.assertEqual(stat.S_IMODE((target / "manifests/dataset.json").stat().st_mode), 0o600)
        self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o700 for path in target.rglob("*") if path.is_dir()))
        repeat = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(json.loads(repeat.stdout)["code"], "OUTPUT_ALREADY_EXISTS")

    def test_cli_console_contains_only_counts_digest_and_fixed_errors(self):
        self.wav()
        self.clip(transcript="SENSITIVE-FICTIONAL-TRANSCRIPT", device_profile="SENSITIVE-FICTIONAL-DEVICE")
        self.save_manifest()
        result = subprocess.run([sys.executable, str(MODULE_PATH), "validate", "--root", str(self.root), "--manifest", str(self.manifest), "--output", str(self.root / "cli-review")], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])
        for secret in ("SENSITIVE", str(self.root), "synth-1", "ZH-B01", "train/zh"):
            self.assertNotIn(secret, result.stdout + result.stderr)
        self.manifest.write_text("malformed PRIVATE BODY")
        result = subprocess.run([sys.executable, str(MODULE_PATH), "validate", "--root", str(self.root), "--manifest", str(self.manifest), "--output", str(self.root / "unused")], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {"ok": False, "code": "INVALID_JSON"})
        self.assertNotIn("PRIVATE BODY", result.stdout + result.stderr)

    def test_actual_cli_validate_review_and_export_preserve_preparation_status(self):
        self.wav()
        self.clip(transcript="FICTIONAL-PRIVATE-CLI-TEXT")
        self.save_manifest()
        review_dir = self.root / "actual-cli-review"
        validate = subprocess.run([sys.executable, str(MODULE_PATH), "validate", "--root", str(self.root), "--manifest", str(self.manifest), "--output", str(review_dir)], capture_output=True, text=True, check=False)
        self.assertEqual(validate.returncode, 0, validate.stderr)
        receipt = json.loads(validate.stdout)
        command = [sys.executable, str(MODULE_PATH), "export", "--root", str(self.root), "--manifest", str(self.manifest), "--review-report", str(review_dir / "review.json"), "--review-sha256", receipt["report_sha256"], "--output", str(self.root / "actual-cli-export")]
        unconfirmed = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(unconfirmed.returncode, 1)
        self.assertEqual(json.loads(unconfirmed.stdout)["code"], "EXPLICIT_REVIEW_REQUIRED")
        confirmed = subprocess.run(command + ["--confirm-reviewed"], capture_output=True, text=True, check=False)
        self.assertEqual(confirmed.returncode, 0, confirmed.stderr)
        result = json.loads(confirmed.stdout)
        self.assertFalse(result["audio_copied"])
        self.assertFalse(result["uploaded"])
        self.assertFalse(result["training_started"])
        self.assertNotIn("FICTIONAL-PRIVATE-CLI-TEXT", confirmed.stdout + confirmed.stderr)
        candidates = json.loads((self.root / "actual-cli-export/candidate-manifest.json").read_text())
        self.assertEqual(candidates["status"], "prepared_not_uploaded")
        self.assertEqual(candidates["groups"]["zh"][0]["phrase_id"], "ZH-B01")


if __name__ == "__main__":
    unittest.main()
