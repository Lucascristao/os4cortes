"""Small offline contracts for composition timing, integrity, and scene resume."""
import copy
from pathlib import Path
import unittest
from unittest.mock import patch

from processor.editorial_renderer import build_timeline, fingerprint, scene_fingerprint, validate_voice_bundle, _cache_valid, _validate_voice_policy, StaleVoicePolicy


class EditorialRendererTests(unittest.TestCase):
    def test_timeline_uses_real_audio_never_cuts_tail_and_stays_contiguous(self):
        plan = {"scenes": [{"id": "opening", "kind": "narration"}, {"id": "source", "kind": "clip", "start": 3.1, "end": 5.25}, {"id": "ending", "kind": "narration"}]}
        timeline = build_timeline(plan, {"opening": .991, "ending": 1.013}, fps=30)
        previous = 0
        for scene in timeline:
            self.assertAlmostEqual(scene["start"], previous)
            self.assertGreaterEqual(scene["duration"], scene["content_duration"])
            self.assertLess(scene["duration"] - scene["content_duration"], 1/30)
            previous = scene["end"]
        self.assertEqual(timeline[-1]["end"]*30, sum(scene["frames"] for scene in timeline))

    def test_altered_successful_voice_bundle_is_rejected_without_paid_repair(self):
        text = "Ela diz não saber."
        text_hash = __import__("hashlib").sha256(text.encode()).hexdigest()
        row = {"id": "opening", "file": "opening.wav", "narration": text, "narration_sha256": text_hash,
               "audio_sha256": "approved-hash", "output_fidelity": {"passed": True}}
        manifest = {"status": "success", "model": "gemini-3.8-live", "voice": "Charon", "scenes": [row]}
        sidecar = {"narration_sha256": text_hash, "audio_sha256": "approved-hash"}
        with patch("processor.editorial_renderer._json", side_effect=[manifest, sidecar]), patch("processor.editorial_renderer.file_sha256", return_value="changed-hash"), patch("processor.editorial_renderer.synthesize_editorial_voice", side_effect=AssertionError("No paid requests")) as synth:
            with self.assertRaisesRegex(ValueError, "WAV hash mismatch"):
                validate_voice_bundle({"scenes": [{"id": "opening", "kind": "narration", "text": text}]}, "voice", require_alignment=False)
            synth.assert_not_called()

    def test_scene_change_leaves_other_scene_cache_identity_unchanged(self):
        base = {"source_hash": "source", "canvas": [1080, 1920, 30], "lower_third": ["crop", .3], "words": [], "font_hash": "font"}
        first = {"id": "first", "kind": "narration", "text": "Uma pergunta?"}
        second = {"id": "second", "kind": "clip", "start": 1, "end": 3}
        old_first, old_second = scene_fingerprint(first, **base), scene_fingerprint(second, **base)
        changed = copy.deepcopy(first)
        changed["text"] = "Outra pergunta?"
        self.assertNotEqual(old_first, scene_fingerprint(changed, **base))
        self.assertEqual(old_second, scene_fingerprint(second, **base))
        with patch("processor.editorial_renderer._json", return_value={"key": old_second, "sha256": "video-hash"}), patch("pathlib.Path.is_file", return_value=True), patch("processor.editorial_renderer.file_sha256", return_value="video-hash"):
            self.assertTrue(_cache_valid("record.json", old_second, "scene.mp4"))
            self.assertFalse(_cache_valid("record.json", fingerprint("changed"), "scene.mp4"))

    def test_changed_global_voice_direction_cannot_approve_an_old_successful_bundle(self):
        current = {"voice_policy_fingerprint": "current", "speech_profile_fingerprint": "current-speech", "global_direction_fingerprint": "current-global"}
        old = {**current, "global_direction_fingerprint": "old-global", "status": "success"}
        with patch("processor.editorial_renderer.prepare_voice_jobs", return_value=(None, [], current)):
            with self.assertRaises(StaleVoicePolicy):
                _validate_voice_policy({}, "voice", old, {}, None)

    def test_external_override_requires_unchanged_plan_and_local_override_requires_caller(self):
        from processor.editorial_voice import prepare_voice_jobs
        plan = {"version": 1, "source": {"label": "Fonte", "date": ""}, "scenes": [
            {"id": "opening", "kind": "narration", "text": "Ela diz não saber.", "background": {"start": 1, "end": 2},
             "visual": {"title": "Uma resposta", "lines": []}, "tts": {"delivery": "explain"}, "evidence": [{"start": 1, "end": 2}]},
            {"id": "clip", "kind": "clip", "start": 1, "end": 2}]}
        _, jobs, manifest = prepare_voice_jobs(plan, output_dir="unused-output", delivery_overrides={"opening": "hook"})
        manifest.update(runtime_source="external-ode", ode_checkout_required=True)
        voices = {"opening": {"path": Path("voice/opening.wav"), "metadata": manifest["scenes"][0]}}
        sidecar = {key: manifest[key] for key in ("voice_policy_fingerprint", "speech_profile_fingerprint")}
        sidecar["scene_direction_fingerprint"] = jobs[0]["direction_fingerprint"]
        changed = copy.deepcopy(plan)
        changed["scenes"][0]["tts"]["delivery"] = "contrast"
        with patch("processor.editorial_renderer._json", return_value=sidecar):
            _validate_voice_policy(plan, "voice", manifest, voices, None)
            with self.assertRaises(StaleVoicePolicy):
                _validate_voice_policy(changed, "voice", manifest, voices, None)
            manifest.update(runtime_source="os4-local-port", ode_checkout_required=False)
            with self.assertRaises(StaleVoicePolicy):
                _validate_voice_policy(plan, "voice", manifest, voices, None)
            _validate_voice_policy(plan, "voice", manifest, voices, {"opening": "hook"})


if __name__ == "__main__":
    unittest.main()
