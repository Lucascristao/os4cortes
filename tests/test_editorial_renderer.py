"""Small offline contracts for composition timing, integrity, and scene resume."""
import copy
from contextlib import nullcontext
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from processor.editorial_renderer import build_timeline, editorial_timing_report, fingerprint, scene_fingerprint, validate_voice_bundle, _cache_valid, _validate_voice_policy, StaleVoicePolicy
from processor.editorial_renderer import _rejected_alignment_scenes, _ensure_voice_bundle
from processor.editorial_renderer import render_editorial_cut, preflight_editorial_visuals
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

    def test_unexpected_preflight_error_is_not_silently_treated_as_cover_failure(self):
        from processor.editorial_visuals import Canvas
        plan = {"source": {"label": "Fonte", "date": ""}, "scenes": [
            {"id": "opening", "kind": "narration", "visual": {"title": "Um título"}},
            {"id": "source", "kind": "clip", "start": 1, "end": 3}]}
        with patch("processor.editorial_visuals.layout_overlay"), \
             patch("processor.covers.normalize_cover", side_effect=OSError("Unexpected filesystem error")):
            with self.assertRaisesRegex(OSError, "Unexpected filesystem"):
                preflight_editorial_visuals(plan, canvas=Canvas.for_format(), font_path="font.ttf", title="Título")

    def test_every_scene_is_preflighted_before_cover_scan_media_or_voice(self):
        from processor.covers import TITLE_FONT
        plan = {"source": {"label": "Fonte", "date": ""}, "scenes": [
            {"id": "opening", "kind": "narration", "visual": {"title": "Um título", "lines": ["Uma ideia."]}},
            {"id": "source", "kind": "clip", "start": 1, "end": 3},
            {"id": "closing", "kind": "narration", "visual": {"title": "Uma pergunta", "lines": ["W"*140]}}]}
        with tempfile.TemporaryDirectory() as folder, \
             patch("pathlib.Path.is_file", return_value=True), \
             patch("processor.editorial_renderer.normalize_editorial_plan", return_value=plan), \
             patch("processor.editorial_renderer.captions.carregar_palavras", return_value=[]), \
             patch("processor.editorial_renderer.validate_source_ranges"), \
             patch("processor.editorial_renderer._font", return_value=(TITLE_FONT, "Archivo Black")), \
             patch("processor.editorial_renderer._tool_path") as media_tools, \
             patch("processor.covers._select_frame") as scan, \
             patch("processor.editorial_renderer._run") as command, \
             patch("processor.editorial_renderer._ensure_voice_bundle") as voice:
            with self.assertRaisesRegex(ValueError, r"CORTE01 / cena closing / visual\.lines\[0\]"):
                render_editorial_cut("source.mp4", "transcript.json", plan, Path(folder)/"CORTE01.mp4", work_dir=Path(folder)/"work")
            voice.assert_not_called()
            scan.assert_not_called()
            command.assert_not_called()
            media_tools.assert_not_called()

    def test_actual_cut30_cover_passes_preflight_with_its_entire_title_without_scanning(self):
        from processor import covers
        from processor.editorial_visuals import Canvas
        plan = {"source": {"label": "Fonte", "date": ""}, "scenes": [
            {"id": "opening", "kind": "narration", "visual": {"title": "O centro do poder", "lines": []}}]}
        cover = {"version": 1, "template_id": "03_close", "title": "POR QUE TUDO PASSA POR BRASÍLIA?"}
        with patch("processor.covers._select_frame") as scan, \
             patch("processor.covers._fit_title", wraps=covers._fit_title) as fit:
            result = preflight_editorial_visuals(plan, canvas=Canvas.for_format("16:9"), font_path=covers.TITLE_FONT,
                                                cover=cover, cut_label="CORTE30")
            self.assertIsNone(result["cover_error"])
            self.assertTrue(fit.called)
            self.assertTrue(all(call.args[0] == cover["title"] for call in fit.call_args_list))
            scan.assert_not_called()

    def test_cover_only_failure_preserves_completed_video_voice_and_visible_pending_metadata(self):
        from processor.covers import TITLE_FONT, CoverError
        plan = {"source": {"label": "Fonte", "date": ""}, "scenes": [
            {"id": "opening", "kind": "narration", "text": "Uma fala.", "background": {"start": 1, "end": 3},
             "visual": {"title": "O centro do poder", "lines": []}},
            {"id": "source", "kind": "clip", "start": 1, "end": 3}]}
        for stage in ("preflight", "render"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                source, transcript, raw_voice = root/"source.mp4", root/"transcript.json", root/"raw.wav"
                source.write_bytes(b"source")
                transcript.write_text("{}")
                raw_voice.write_bytes(b"accepted raw voice")
                cover = {"version": 1, "template_id": "03_close", "title": "W"*60 if stage == "preflight" else "QUEM PAGA?"}
                voice_info = {"path": raw_voice, "sha256": "hash"}
                treated = {"path": raw_voice, "sha256": "hash", "duration": 1, "timeline_duration": 1,
                           "words": [{"texto": "Uma", "inicio": 0, "fim": 1}], "raw_sha256": "hash",
                           "raw_duration": 1, "derived_key": "derived", "derived_cache_hit": False}

                def write_media(path):
                    path = Path(path)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"completed media")

                with patch("processor.editorial_renderer.normalize_editorial_plan", return_value=plan), \
                     patch("processor.editorial_renderer.captions.carregar_palavras", return_value=[{"texto": "fala", "inicio": 1, "fim": 2}]), \
                     patch("processor.editorial_renderer.validate_source_ranges"), \
                     patch("processor.editorial_renderer._font", return_value=(TITLE_FONT, "Archivo Black")), \
                     patch("processor.editorial_renderer.file_sha256", return_value="hash"), \
                     patch("processor.editorial_renderer._tool_path", return_value=nullcontext()), \
                     patch("processor.covers.render_cover", side_effect=CoverError("cover: frame indisponível")) as cover_render, \
                     patch("processor.editorial_renderer._ensure_voice_bundle", return_value=({"model": "gemini-3.8-live", "voice": "Charon"}, {"opening": voice_info}, None)) as voice, \
                     patch("processor.editorial_renderer.derive_narration", return_value=treated), \
                     patch("processor.editorial_renderer._wave_stats", return_value={"active_energy": 1, "active_windows": 1, "peak": .1, "active_rms": .1}), \
                     patch("processor.editorial_renderer._cache_valid", return_value=False), \
                     patch("processor.editorial_renderer._caption_assets", return_value=(root/"captions.ass", [{"start": 0, "end": 1, "text": "Uma fala."}])), \
                     patch("processor.editorial_renderer._encode_silent_scene", side_effect=lambda video, scene, scene_dir, output, **kwargs: write_media(output)), \
                     patch("processor.editorial_renderer._master_audio", side_effect=lambda records, output, **kwargs: write_media(output)), \
                     patch("processor.editorial_renderer._run", side_effect=lambda command: write_media(command[-1])), \
                     patch("processor.editorial_renderer._probe_output", return_value={"streams": [{"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920}, {"codec_type": "audio", "codec_name": "aac"}], "format": {"duration": 3}}):
                    result = render_editorial_cut(source, transcript, plan, root/"CORTE30.mp4", work_dir=root/"work", cover=cover)
                self.assertEqual(result["video"].read_bytes(), b"completed media")
                self.assertTrue(result["srt"].is_file())
                self.assertEqual(raw_voice.read_bytes(), b"accepted raw voice")
                self.assertIsNone(result["capa"])
                self.assertIn("CORTE30 / capa / cover", result["cover_error"])
                self.assertEqual(result["cover_warning"]["stage"], stage)
                report = json.loads(result["report"].read_text(encoding="utf-8"))
                self.assertIsNone(report["capa"])
                self.assertEqual(report["cover_error"], result["cover_error"])
                self.assertEqual(report["cover"]["status"], "pending")
                voice.assert_called_once()
                self.assertEqual(cover_render.call_count, 0 if stage == "preflight" else 1)

    def test_local_raw_voice_survives_synthesis_or_derivative_failure(self):
        plan = {"source": {"label": "Fonte", "date": ""}, "scenes": [
            {"id": "opening", "kind": "narration", "visual": {"title": "Um título"}},
            {"id": "source", "kind": "clip", "start": 1, "end": 3}]}
        for voice_failed in (False, True):
            events = []

            def ensure(*args, **kwargs):
                events.append("voice")
                voice_dir = Path(args[1])
                voice_dir.mkdir(parents=True, exist_ok=True)
                (voice_dir / "accepted.wav").write_bytes(b"accepted raw voice")
                if voice_failed:
                    raise RuntimeError("partial voice failure")
                return {}, {"opening": {}}, None

            def derive(*args, **kwargs):
                events.append("derivative")
                raise RuntimeError("derivative boundary")

            with self.subTest(voice_failed=voice_failed), tempfile.TemporaryDirectory() as folder, \
                 patch("pathlib.Path.is_file", return_value=True), \
                 patch("processor.editorial_renderer.normalize_editorial_plan", return_value=plan), \
                 patch("processor.editorial_renderer.captions.carregar_palavras", return_value=[]), \
                 patch("processor.editorial_renderer.validate_source_ranges"), \
                 patch("processor.editorial_renderer._font", return_value=(Path("font.ttf"), "Archivo Black")), \
                 patch("processor.editorial_renderer.preflight_editorial_visuals", return_value={"cover_error": None, "cover_warning": None}), \
                 patch("processor.editorial_renderer.file_sha256", return_value="hash"), \
                 patch("processor.editorial_renderer._tool_path", return_value=nullcontext()), \
                 patch("processor.covers.render_cover", return_value={}), \
                 patch("processor.editorial_renderer._ensure_voice_bundle", side_effect=ensure), \
                 patch("processor.editorial_renderer.derive_narration", side_effect=derive):
                with self.assertRaisesRegex(RuntimeError, "partial voice failure" if voice_failed else "derivative boundary"):
                    render_editorial_cut("source.mp4", "transcript.json", plan, Path(folder)/"CORTE01.mp4",
                                         work_dir=Path(folder)/"work")
                self.assertEqual((Path(folder)/"work"/"voice"/"accepted.wav").read_bytes(), b"accepted raw voice")
                self.assertEqual(events, ["voice"] if voice_failed else ["voice", "derivative"])

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
