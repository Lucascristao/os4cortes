"""Lossless session checkpoints use the same text, voice and fidelity gates."""
import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch
import wave
import zipfile

from processor import editorial_alignment
from processor import voice_cache
from processor.editorial_renderer import _ensure_voice_bundle
from processor.drive import DriveUploader


def plan():
    return {"version": 1, "source": {"label": "Fonte", "date": ""}, "scenes": [
        {"id": "opening", "kind": "narration", "text": "Uma resposta simples.",
         "background": {"start": 1, "end": 3}, "visual": {"title": "Uma resposta", "lines": []},
         "tts": {"delivery": "explain"}, "evidence": [{"start": 1, "end": 3}]},
        {"id": "source", "kind": "clip", "start": 1, "end": 3},
        {"id": "ending", "kind": "narration", "text": "Outra resposta simples.",
         "background": {"start": 1, "end": 3}, "visual": {"title": "Outra resposta", "lines": []},
         "tts": {"delivery": "explain"}, "evidence": [{"start": 1, "end": 3}]},
    ]}


def wav_duration(path):
    with wave.open(str(path), "rb") as source:
        return source.getnframes() / source.getframerate()


class MemoryDrive:
    def __init__(self):
        self.files = {}
        self.upload_count = 0

    def find_file_by_name(self, name, *, folder_id):
        return name if (folder_id, name) in self.files else None

    def upsert(self, path, name, *, folder_id):
        self.files[folder_id, name] = Path(path).read_bytes()
        self.upload_count += 1
        return name

    def download(self, identifier, output):
        matches = [data for (folder, name), data in self.files.items() if name == identifier]
        Path(output).write_bytes(matches[0])


class VoiceCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".test-voice-cache-", dir=Path(__file__).resolve().parents[1])
        self.root = Path(self.temp.name)
        self.plan = plan()
        self.source = self.root / "raw"
        self.source.mkdir()
        self.key, self.worker, self.jobs, self.expected = voice_cache.voice_cache_identity(self.plan, self.source)
        self.duration_patch = patch.object(self.worker, "duration_seconds", side_effect=wav_duration)
        self.duration_patch.start()

    def tearDown(self):
        self.duration_patch.stop()
        self.temp.cleanup()

    def make_audio(self, job):
        path = job["output_file"]
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(24000)
            output.writeframes(b"\x11\x00" * 48000)
        self.worker.save_audio_sidecar(path, job["narration_hash"], self.expected["model"], self.expected["voice"],
            2.0, speech_profile_fingerprint=self.expected["speech_profile_fingerprint"],
            output_transcription=job["narration"], output_transcription_similarity=1.0,
            direction_fingerprint=job["direction_fingerprint"], fidelity={"passed": True})

    def make_alignment(self):
        rows = []
        for job in self.jobs:
            words = editorial_alignment.canonical_words(job["narration"])
            rows.append({"id": job["scene_id"], "audio_sha256": self.worker.audio_sha256(job["output_file"]),
                "narration_sha256": job["narration_hash"], "coverage": 1.0,
                "palavras": [{"texto": word, "inicio": index * .5, "fim": (index + 1) * .5} for index, word in enumerate(words)],
                "diagnostics": {"passed": True, "direct_coverage": 1.0, "unresolved_word_count": 0,
                                "timing_sources": ["asr"] * len(words)}})
        manifest = voice_cache._safe_manifest(self.expected, [(job, 2.0, json.loads(job["output_file"].with_suffix(".tts.json").read_text())) for job in self.jobs], True)
        (self.source / "aligned-words.json").write_text(json.dumps({"version": editorial_alignment.VERSION,
            "status": "success", "asr_model": "base", "initial_prompt": editorial_alignment.build_vocabulary_prompt(manifest),
            "scenes": rows}), encoding="utf-8")

    def test_visual_cover_and_source_clip_edits_keep_voice_identity_but_script_and_direction_do_not(self):
        changed = copy.deepcopy(self.plan)
        changed["scenes"][0]["visual"]["title"] = "Título visual corrigido"
        changed["scenes"][0]["visual"]["lines"] = ["Linha menor"]
        changed["scenes"][1].update(start=2, end=4)
        self.assertEqual(voice_cache.voice_cache_identity(changed, self.root / "elsewhere")[0], self.key)
        for change in ("text", "delivery"):
            changed = copy.deepcopy(self.plan)
            if change == "text":
                changed["scenes"][0]["text"] = "Uma pergunta diferente?"
            else:
                changed["scenes"][0]["tts"]["delivery"] = "question"
            self.assertNotEqual(voice_cache.voice_cache_identity(changed, self.source)[0], self.key)
        with patch.object(self.worker, "DEFAULT_TTS_VOICE", "different"):
            with self.assertRaisesRegex(RuntimeError, "voz"):
                voice_cache.voice_cache_identity(self.plan, self.source)

    def test_complete_drive_restore_uses_identical_originals_without_synthesis_or_asr(self):
        for job in self.jobs:
            self.make_audio(job)
        self.make_alignment()
        self.source.joinpath("derived").mkdir()
        self.source.joinpath("derived", "treated.wav").write_bytes(b"not an original")
        self.source.joinpath("live-diagnostics.json").write_text('{"secret":"never archive"}')
        drive = MemoryDrive()
        cache = voice_cache.SessionVoiceCache(drive, "session", self.plan, self.source)
        result = cache.checkpoint()
        self.assertTrue(result["complete"])
        cache.checkpoint()
        self.assertEqual(drive.upload_count, 1, "o mesmo WAV não gera checkpoints duplicados")
        target = self.root / "restored"
        restored = voice_cache.SessionVoiceCache(drive, "session", self.plan, target).restore()
        self.assertEqual(restored["acceptedCount"], 2)
        for job in self.jobs:
            self.assertEqual(job["output_file"].read_bytes(), (target / job["output_file"].name).read_bytes())
        with patch("processor.editorial_renderer.synthesize_editorial_voice") as synth:
            manifest, voices, aligned = _ensure_voice_bundle(self.plan, target, allow_synthesis=False,
                delivery_overrides=None, asr_model="base")
        synth.assert_not_called()
        self.assertEqual(set(voices), {"opening", "ending"})
        self.assertEqual(aligned["status"], "success")
        with zipfile.ZipFile(io.BytesIO(next(iter(drive.files.values())))) as archive:
            self.assertNotIn("live-diagnostics.json", archive.namelist())
            self.assertFalse(any("derived" in name for name in archive.namelist()))
            self.assertNotIn("credential_present", archive.read("narration-manifest.json").decode())
        self.assertIsNone(voice_cache.SessionVoiceCache(drive, "other-session", self.plan, self.root/"other").restore())

    def test_partial_preserves_accepted_scene_and_missing_scene_still_requires_generation(self):
        self.make_audio(self.jobs[0])
        archive = self.root / "partial.zip"
        result = voice_cache.build_voice_archive(self.plan, self.source, archive)
        self.assertFalse(result["complete"])
        target = self.root / "partial-restore"
        restored = voice_cache.restore_voice_archive(self.plan, archive, target)
        self.assertEqual(restored["acceptedCount"], 1)
        self.assertEqual((target/"opening.wav").read_bytes(), self.jobs[0]["output_file"].read_bytes())
        self.assertFalse((target/"ending.wav").exists())
        self.assertEqual(json.loads((target/"narration-manifest.json").read_text())["status"], "failed")
        with patch("processor.editorial_renderer.synthesize_editorial_voice", side_effect=RuntimeError("generation required")) as synth:
            with self.assertRaisesRegex(RuntimeError, "generation required"):
                _ensure_voice_bundle(self.plan, target, allow_synthesis=True, delivery_overrides=None, asr_model="base")
        synth.assert_called_once()

    def test_recomputed_archive_checksums_cannot_approve_changed_text_or_model(self):
        for job in self.jobs:
            self.make_audio(job)
        original = self.root / "valid.zip"
        voice_cache.build_voice_archive(self.plan, self.source, original)
        for mutation in ("checksum", "model", "transcript", "traversal"):
            with self.subTest(mutation=mutation):
                with zipfile.ZipFile(original) as archive:
                    files = {name: archive.read(name) for name in archive.namelist()}
                if mutation == "traversal":
                    files["../escape.wav"] = b"bad"
                else:
                    sidecar = json.loads(files["opening.tts.json"])
                    sidecar["model" if mutation == "model" else "output_transcription"] = "other-model" if mutation == "model" else "Uma fala indevida."
                    files["opening.tts.json"] = json.dumps(sidecar).encode()
                    if mutation != "checksum":
                        index = json.loads(files["checkpoint.json"])
                        for row in index["files"]:
                            if row["name"] == "opening.tts.json":
                                row.update(size=len(files[row["name"]]), sha256=hashlib.sha256(files[row["name"]]).hexdigest())
                        files["checkpoint.json"] = json.dumps(index).encode()
                corrupt = self.root / f"{mutation}.zip"
                with zipfile.ZipFile(corrupt, "w") as archive:
                    for name, data in files.items():
                        archive.writestr(name, data)
                destination = self.root / f"restore-{mutation}"
                with self.assertRaises(voice_cache.VoiceCacheError):
                    voice_cache.restore_voice_archive(self.plan, corrupt, destination)
                self.assertFalse(destination.exists(), "rejected bundles never enter the active voice directory")

    def test_drive_access_and_save_errors_are_not_disguised_as_cache_misses(self):
        drive = Mock()
        drive.find_file_by_name.side_effect = RuntimeError("Drive permission denied")
        cache = voice_cache.SessionVoiceCache(drive, "session", self.plan, self.source)
        with self.assertRaisesRegex(RuntimeError, "permission denied"):
            cache.restore()
        self.make_audio(self.jobs[0])
        drive.upsert.side_effect = RuntimeError("Drive write refused")
        with self.assertRaisesRegex(voice_cache.VoiceCacheError, "preservar.*write refused"):
            cache.checkpoint()

    def test_drive_lookup_escapes_exact_folder_and_name_and_upserts_existing_id(self):
        uploader = DriveUploader.__new__(DriveUploader)
        uploader.folder_id = "default"
        uploader.service = Mock()
        uploader.service.files().list().execute.return_value = {"files": [{"id": "cached-file"}]}
        self.assertEqual(uploader.find_file_by_name("voice's.zip", folder_id="session"), "cached-file")
        query = uploader.service.files().list.call_args.kwargs["q"]
        self.assertIn("'session' in parents", query)
        self.assertIn("voice\\'s.zip", query)
        uploader.service.files().update().execute.return_value = {"id": "cached-file"}
        with patch("processor.drive.MediaFileUpload"):
            self.assertEqual(uploader.upsert(self.source/"cache.zip", "voice's.zip", folder_id="session"), "cached-file")
        uploader.service.files().create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
