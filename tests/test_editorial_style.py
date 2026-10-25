"""Visual preset compatibility and real approved audio/alignment cache reuse."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

from processor import editorial_alignment, editorial_voice
from processor.editorial_plan import (
    editorial_fingerprint, normalize_editorial_plan, voice_plan_fingerprint,
)
from processor.editorial_renderer import _ensure_voice_bundle


def plan():
    return {
        "version": 1, "source": {"label": "Fonte", "date": ""},
        "scenes": [
            {"id": "opening", "kind": "narration", "text": "Ela diz não saber.",
             "background": {"start": 1, "end": 3},
             "visual": {"title": "O limite da resposta", "lines": ["Uma resposta atribuída."]},
             "tts": {"delivery": "explain"}, "evidence": [{"start": 1, "end": 3}]},
            {"id": "source", "kind": "clip", "start": 1, "end": 3},
        ],
    }


def approved_bundle(directory):
    """Make a small local fixture with the same integrity metadata as a render."""
    raw = plan()
    _, jobs, manifest = editorial_voice.prepare_voice_jobs(raw, output_dir=directory)
    job, row = jobs[0], manifest["scenes"][0]
    audio = directory / row["file"]
    with wave.open(str(audio), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(24000)
        handle.writeframes(b"\x01\x00" * 24000)
    audio_hash = hashlib.sha256(audio.read_bytes()).hexdigest()
    row.update(audio_sha256=audio_hash, duration_seconds=1.0,
               output_transcription=job["narration"], output_fidelity={"passed": True})
    manifest["status"] = "success"
    sidecar = {
        "model": manifest["model"], "voice": manifest["voice"],
        "audio_sha256": audio_hash, "narration_sha256": job["narration_hash"],
        "output_transcription": job["narration"], "output_fidelity": {"passed": True},
        "scene_direction_fingerprint": job["direction_fingerprint"],
        **{field: manifest[field] for field in ("voice_policy_fingerprint", "speech_profile_fingerprint")},
    }
    words = [
        {"texto": word, "inicio": index*.2, "fim": (index+1)*.2,
         "timing_source": "asr-exact-normalized", "estimated": False}
        for index, word in enumerate(editorial_alignment.canonical_words(job["narration"]))
    ]
    aligned = {
        "version": editorial_alignment.VERSION, "status": "success", "asr_model": "base",
        "initial_prompt": editorial_alignment.build_vocabulary_prompt(manifest),
        "scenes": [{"id": row["id"], "audio_sha256": audio_hash,
                    "narration_sha256": job["narration_hash"], "coverage": 1.0, "palavras": words,
                    "diagnostics": {"passed": True, "direct_coverage": 1.0,
                                    "unresolved_word_count": 0,
                                    "timing_sources": [word["timing_source"] for word in words]}}],
    }
    for path, content in ((directory/"narration-manifest.json", manifest),
                          (audio.with_suffix(".tts.json"), sidecar),
                          (directory/"aligned-words.json", aligned)):
        path.write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
    return raw, audio


class EditorialStyleTests(unittest.TestCase):
    def test_legacy_normalization_does_not_add_a_style_and_explicit_choices_survive(self):
        raw = plan()
        original = copy.deepcopy(raw)
        normalized = normalize_editorial_plan(raw)
        self.assertNotIn("visual_style", normalized)
        for style in ("classic", "paper"):
            with self.subTest(style=style):
                selected = normalize_editorial_plan({**raw, "visual_style": style})
                self.assertEqual(selected.pop("visual_style"), style)
                self.assertEqual(selected, normalized)
        self.assertEqual(raw, original)

    def test_unknown_or_nontext_styles_fail_before_voice_preparation(self):
        for style in (None, False, True, 0, 1, "", "Paper", "new", [], {}):
            with self.subTest(style=style), patch.object(editorial_voice, "_load_worker") as worker:
                with self.assertRaisesRegex(ValueError, "editorial.visual_style"):
                    editorial_voice.prepare_voice_jobs({**plan(), "visual_style": style}, output_dir="unused")
                worker.assert_not_called()

    def test_voice_cache_key_retains_legacy_hash_but_visual_plan_hash_changes(self):
        normalized = normalize_editorial_plan(plan())
        old_key = editorial_fingerprint(normalized)
        for style in ("classic", "paper"):
            selected = {**normalized, "visual_style": style}
            self.assertEqual(voice_plan_fingerprint(selected), old_key)
            self.assertNotEqual(editorial_fingerprint(selected), old_key)
        self.assertEqual(voice_plan_fingerprint(normalized), old_key)
        changed = copy.deepcopy(normalized)
        changed["scenes"][0]["tts"]["delivery"] = "question"
        self.assertNotEqual(voice_plan_fingerprint(changed), old_key)

    def test_style_changes_preserve_every_speech_fingerprint_and_job(self):
        raw = plan()
        _, original_jobs, original = editorial_voice.prepare_voice_jobs(raw, output_dir="unused")
        for style in ("classic", "paper"):
            with self.subTest(style=style):
                _, jobs, manifest = editorial_voice.prepare_voice_jobs({**raw, "visual_style": style}, output_dir="unused")
                self.assertEqual(jobs, original_jobs)
                for field in ("source_plan_fingerprint", "speech_profile_fingerprint",
                              "global_direction_fingerprint", "voice_policy_fingerprint", "scenes"):
                    self.assertEqual(manifest[field], original[field])
        changed = copy.deepcopy(raw)
        changed["scenes"][0]["text"] = "Ela diz que sabe."
        _, jobs, manifest = editorial_voice.prepare_voice_jobs(changed, output_dir="unused")
        self.assertNotEqual(jobs[0]["narration_hash"], original_jobs[0]["narration_hash"])
        self.assertNotEqual(manifest["source_plan_fingerprint"], original["source_plan_fingerprint"])

    def test_switching_style_reuses_real_approved_wav_and_alignment_without_synthesis(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            raw, audio = approved_bundle(directory)
            before = {file.name: file.read_bytes() for file in directory.iterdir()}
            selected = normalize_editorial_plan({**raw, "visual_style": "paper"})
            with patch("processor.editorial_renderer.synthesize_editorial_voice", side_effect=AssertionError("Paid synthesis forbidden")) as synth:
                manifest, voices, aligned = _ensure_voice_bundle(
                    selected, directory, allow_synthesis=True, delivery_overrides=None, asr_model="base")
            synth.assert_not_called()
            self.assertEqual(manifest["status"], "success")
            self.assertEqual(voices["opening"]["path"], audio)
            self.assertEqual(aligned["status"], "success")
            self.assertEqual({file.name: file.read_bytes() for file in directory.iterdir()}, before)


if __name__ == "__main__":
    unittest.main()
