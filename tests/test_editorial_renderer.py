"""Small offline contracts for composition timing, integrity, and scene resume."""
import copy
from contextlib import nullcontext
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from processor.editorial_renderer import build_timeline, editorial_timing_report, fingerprint, scene_fingerprint, validate_voice_bundle, _cache_valid, _validate_voice_policy, StaleVoicePolicy
from processor.editorial_renderer import _rejected_alignment_scenes, _ensure_voice_bundle
from processor.editorial_renderer import render_editorial_cut
from processor import editorial_alignment


class EditorialRendererTests(unittest.TestCase):
    def test_alignment_retry_requires_current_failed_diagnostics_and_matching_audio(self):
        voices = {"opening": {"sha256": "same"}, "ending": {"sha256": "rejected"}}
        report = {"version": editorial_alignment.VERSION, "status": "failed-alignment", "scenes": [
            {"id": "opening", "audio_sha256": "same", "diagnostics": {"passed": True}},
            {"id": "ending", "audio_sha256": "rejected", "diagnostics": {"passed": False, "failures": ["Repeated phrase"]}},
        ]}
        with patch("processor.editorial_renderer._json", return_value=report):
            self.assertEqual(_rejected_alignment_scenes("voices", voices), ["ending"])
            report["scenes"][1]["audio_sha256"] = "stale"
            self.assertEqual(_rejected_alignment_scenes("voices", voices), [])
            report["scenes"][1]["audio_sha256"] = "rejected"
            report["version"] = "old"
            self.assertEqual(_rejected_alignment_scenes("voices", voices), [])

    def test_rejected_audio_has_only_one_paid_retry_and_infrastructure_errors_have_none(self):
        with patch("pathlib.Path.is_file", return_value=True), \
             patch("processor.editorial_renderer._json", return_value={"status": "success"}), \
             patch("processor.editorial_renderer.validate_voice_bundle", return_value=({}, {}, None)), \
             patch("processor.editorial_renderer._validate_voice_policy"), \
             patch("processor.editorial_renderer._effective_overrides", return_value={}), \
             patch("processor.editorial_renderer.editorial_alignment.align_audio_directory", side_effect=RuntimeError("Rejected")) as align, \
             patch("processor.editorial_renderer._rejected_alignment_scenes", return_value=["ending"]) as rejected, \
             patch("processor.editorial_renderer.synthesize_editorial_voice") as synth:
            with self.assertRaises(RuntimeError):
                _ensure_voice_bundle({}, "voices", allow_synthesis=True, delivery_overrides=None, asr_model="base")
            self.assertEqual(align.call_count, 2)
            synth.assert_called_once_with({}, output_dir="voices", delivery_overrides={}, force_scene_ids=["ending"])
            synth.reset_mock()
            rejected.return_value = []
            with self.assertRaises(RuntimeError):
                _ensure_voice_bundle({}, "voices", allow_synthesis=True, delivery_overrides=None, asr_model="base")
            synth.assert_not_called()

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

    def test_opening_measures_all_assembled_narrations_and_only_warns_above_fifteen(self):
        first = {"id": "first", "kind": "narration"}
        second = {"id": "second", "kind": "narration"}
        clip = {"id": "source", "kind": "clip", "start": 3, "end": 13}
        plan = {"scenes": [first, second, clip]}
        timeline = build_timeline(plan, {"first": 8, "second": 8}, fps=30)
        report = editorial_timing_report(plan, timeline)
        self.assertEqual(report["first_original_clip_seconds"], 16)
        self.assertEqual(report["original_content_seconds"], 10)
        self.assertEqual(report["final_duration_seconds"], 26)
        self.assertEqual(len(report["editorial_warnings"]), 1)
        self.assertEqual([row["id"] for row in timeline], ["first", "second", "source"])
        for scenes, expected in (([clip, first, second], 0), ([first, clip, second], 2), ([first, second, clip], 4)):
            short = {"scenes": scenes}
            report = editorial_timing_report(short, build_timeline(short, {"first": 2, "second": 2}))
            self.assertEqual(report["first_original_clip_seconds"], expected)
            self.assertEqual(report["editorial_warnings"], [])

    def test_treatment_speed_does_not_invalidate_original_silent_video(self):
        clip = {"id": "source", "kind": "clip", "start": 1, "end": 3}
        narration = {"id": "opening", "kind": "narration", "text": "Uma fala."}
        base = {"source_hash": "source", "canvas": [1080, 1920, 30], "lower_third": ["off", 0], "words": [], "font_hash": "font"}
        original_key = scene_fingerprint(clip, **base)
        self.assertNotEqual(scene_fingerprint(narration, **base, voice={"duration": 2}),
                            scene_fingerprint(narration, **base, voice={"duration": 2/1.1}))
        self.assertEqual(original_key, scene_fingerprint(clip, **base))

    def test_unrenderable_cover_fails_before_any_voice_synthesis(self):
        plan = {"source": {"label": "Fonte", "date": ""}, "scenes": [
            {"id": "opening", "kind": "narration", "visual": {"title": "Um título"}},
            {"id": "source", "kind": "clip", "start": 1, "end": 3}]}
        render_cover = Mock(side_effect=ValueError("Título da capa não cabe com tamanho legível."))
        with tempfile.TemporaryDirectory() as folder, \
             patch.dict("sys.modules", {"processor.covers": SimpleNamespace(render_cover=render_cover)}), \
             patch("pathlib.Path.is_file", return_value=True), \
             patch("processor.editorial_renderer.normalize_editorial_plan", return_value=plan), \
             patch("processor.editorial_renderer.captions.carregar_palavras", return_value=[]), \
             patch("processor.editorial_renderer.validate_source_ranges"), \
             patch("processor.editorial_renderer._font", return_value=(Path("font.ttf"), "Archivo Black")), \
             patch("processor.editorial_renderer.file_sha256", return_value="source-hash"), \
             patch("processor.editorial_renderer._tool_path", return_value=nullcontext()), \
             patch("processor.editorial_renderer._ensure_voice_bundle") as voice:
            with self.assertRaisesRegex(ValueError, "Título da capa"):
                render_editorial_cut("source.mp4", "transcript.json", plan, Path(folder)/"output.mp4", work_dir=Path(folder)/"work")
            voice.assert_not_called()
            self.assertEqual(render_cover.call_args.args[1], [(1, 3)])

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
