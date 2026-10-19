"""Offline contract tests: no Gemini SDK, key, downloads, or API calls."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from processor import editorial_voice
from processor.voice_runtime.gemini_live_fidelity import evaluate_transcription


def example_plan():
    return {
        "version": 1, "source": {"label": "Fonte", "date": "2026-10-17"},
        "scenes": [
            {"id": "introducao-livre", "kind": "narration", "text": "Ela diz não saber o que ocorreu depois.",
             "background": {"start": 1, "end": 4}, "visual": {"title": "O limite da resposta", "lines": []},
             "tts": {"delivery": "question"}, "evidence": [{"start": 1, "end": 4}]},
            {"id": "fonte", "kind": "clip", "start": 1, "end": 4},
        ],
    }


class EditorialVoiceTests(unittest.TestCase):
    def test_local_runtime_accepts_arbitrary_scene_ids_and_preserves_text_and_plan(self):
        plan = example_plan()
        before = copy.deepcopy(plan)
        worker, jobs, manifest = editorial_voice.prepare_voice_jobs(plan, output_dir="unused-output")
        self.assertEqual(plan, before)
        self.assertEqual(worker.__package__, "processor.voice_runtime")
        self.assertEqual([job["scene_id"] for job in jobs], ["introducao-livre"])
        self.assertEqual(jobs[0]["narration"], plan["scenes"][0]["text"])
        self.assertEqual(jobs[0]["direction"]["delivery"], "question")
        self.assertEqual(manifest["runtime_source"], "os4-local-port")
        self.assertEqual(manifest["channel_identity"], "OS4 de Direita")
        self.assertEqual(manifest["channel_handle"], "@os4dedireita")
        self.assertIn("Você é o narrador do canal OS4 de Direita.", worker.live_session_config("Charon")["system_instruction"])
        self.assertIn("@os4dedireita em todas as redes", manifest["global_direction"])
        self.assertNotIn("OS4 Cortes", manifest["global_direction"])
        self.assertFalse(manifest["ode_checkout_required"])
        self.assertEqual(manifest["fallback_models"], [])

    def test_global_direction_and_scene_overrides_invalidate_cache_without_editing_plan(self):
        plan = example_plan()
        before = copy.deepcopy(plan)
        _, jobs, first = editorial_voice.prepare_voice_jobs(plan, output_dir="unused-output")
        with patch.object(editorial_voice, "OS4_GLOBAL_DIRECTION", editorial_voice.OS4_GLOBAL_DIRECTION + " Nova direção de conversa."):
            _, _, second = editorial_voice.prepare_voice_jobs(plan, output_dir="unused-output")
        self.assertNotEqual(first["global_direction_fingerprint"], second["global_direction_fingerprint"])
        self.assertNotEqual(first["speech_profile_fingerprint"], second["speech_profile_fingerprint"])
        self.assertNotEqual(first["voice_policy_fingerprint"], second["voice_policy_fingerprint"])
        _, overridden, _ = editorial_voice.prepare_voice_jobs(plan, output_dir="unused-output", delivery_overrides={"introducao-livre": "hook"})
        self.assertEqual(overridden[0]["direction"]["delivery"], "hook")
        self.assertNotEqual(jobs[0]["direction_fingerprint"], overridden[0]["direction_fingerprint"])
        self.assertEqual(plan, before)

    def test_preflight_never_enters_synthesis_or_needs_ode_checkout(self):
        worker, _, _ = editorial_voice.prepare_voice_jobs(example_plan(), output_dir="unused-output")
        with patch.object(Path, "mkdir"), patch.object(Path, "write_text") as write, patch.dict("os.environ", {"GEMINI_API_KEY": ""}), patch.object(worker, "synthesize_missing_jobs", side_effect=AssertionError("Must not call TTS")):
            manifest = editorial_voice.synthesize_editorial_voice(example_plan(), output_dir="unused-output", preflight_only=True)
            self.assertEqual(manifest["status"], "blocked-local-prerequisites")
            saved = json.loads(write.call_args.args[0])
            self.assertFalse(saved["credential_present"])
            self.assertEqual(saved["model"], "gemini-3.8-live")
            self.assertEqual(saved["voice"], "Charon")

    def test_lexical_fidelity_still_rejects_missing_negation(self):
        self.assertTrue(evaluate_transcription("Ela diz não saber.", "Ela diz não saber.")["passed"])
        self.assertFalse(evaluate_transcription("Ela diz não saber.", "Ela diz saber.")["passed"])

    def test_baritone_direction_keeps_raw_untreated_and_master_pitch_separate(self):
        worker, _, first = editorial_voice.prepare_voice_jobs(example_plan(), output_dir="unused-output")
        prompt = worker.live_session_config("Charon")["system_instruction"]
        self.assertIn("ressonância de peito suave", prompt)
        self.assertIn("sem forçar voz grossa", prompt)
        self.assertIn("cadência de repórter", prompt)
        self.assertEqual(first["raw_audio_treatment"], "none")
        self.assertEqual(first["raw_pitch_semitones"], 0)
        self.assertEqual(first["master_pitch_semitones"], -1)
        self.assertFalse(first["master_pitch_applied"])
        self.assertFalse(first["continuity"]["cross_scene_websocket_reuse"])
        self.assertFalse(first["continuity"]["perfect_timbre_guaranteed"])
        with patch.object(editorial_voice, "MASTER_PITCH_SEMITONES", 0):
            _, _, second = editorial_voice.prepare_voice_jobs(example_plan(), output_dir="unused-output")
        self.assertEqual(first["voice_policy_fingerprint"], second["voice_policy_fingerprint"])
        self.assertEqual(first["speech_profile_fingerprint"], second["speech_profile_fingerprint"])
        self.assertEqual(second["master_pitch_semitones"], 0)

    def test_force_one_scene_preserves_other_valid_cache_jobs(self):
        plan = example_plan()
        template = copy.deepcopy(plan["scenes"][0])
        plan["scenes"] = [
            {**copy.deepcopy(template), "id": "abertura", "text": "Uma pergunta clara."},
            plan["scenes"][1],
            {**copy.deepcopy(template), "id": "comentario", "text": "Ela diz não saber."},
            {**copy.deepcopy(template), "id": "fechamento", "text": "O contexto muda a leitura."},
        ]
        worker, jobs, _ = editorial_voice.prepare_voice_jobs(plan, output_dir="unused-output")
        narrations = {job["scene_id"]: job["narration"] for job in jobs}
        original_read = Path.read_text

        def read_sidecar(path, *args, **kwargs):
            if path.name.endswith(".tts.json"):
                identifier = path.name.removesuffix(".tts.json")
                return json.dumps({"output_transcription": narrations[identifier]})
            return original_read(path, *args, **kwargs)

        def complete_mocked_synthesis(coroutine):
            # This tests job selection, not asyncio/network infrastructure.
            coroutine.close()
            return {}

        synth = AsyncMock(return_value={})
        with patch.object(Path, "mkdir"), patch.object(Path, "write_text"), patch.object(Path, "read_text", autospec=True, side_effect=read_sidecar), patch.dict("os.environ", {"GEMINI_API_KEY": "offline-test-key"}), patch.object(worker, "cached_duration", return_value=1) as cache, patch.object(worker, "synthesize_missing_jobs", synth), patch.object(editorial_voice.asyncio, "run", side_effect=complete_mocked_synthesis), patch.object(worker, "duration_seconds", return_value=1), patch.object(worker, "audio_sha256", return_value="unchanged-or-generated-hash"):
            manifest = editorial_voice.synthesize_editorial_voice(plan, output_dir="unused-output", force_scene_ids=["fechamento"])
        self.assertEqual(manifest["status"], "success")
        self.assertEqual(manifest["forced_scene_ids"], ["fechamento"])
        self.assertEqual([job["scene_id"] for job in synth.call_args.args[0]], ["fechamento"])
        self.assertEqual(cache.call_count, 2)
        self.assertEqual([call.args[0].stem for call in cache.call_args_list], ["abertura", "comentario"])
        self.assertEqual([scene["narration"] for scene in manifest["scenes"]], [job["narration"] for job in jobs])

    def test_force_unknown_or_non_list_ids_fails_before_cache_or_synthesis(self):
        worker, _, _ = editorial_voice.prepare_voice_jobs(example_plan(), output_dir="unused-output")
        for forced in (["unknown"], ["fonte"], "introducao-livre", ["introducao-livre", "introducao-livre"]):
            with self.subTest(forced=forced), patch.object(worker, "synthesize_missing_jobs", AsyncMock()) as synth, patch.object(worker, "cached_duration") as cache:
                with self.assertRaisesRegex(ValueError, "force_scene_ids"):
                    editorial_voice.synthesize_editorial_voice(example_plan(), output_dir="unused-output", force_scene_ids=forced)
                synth.assert_not_called()
                cache.assert_not_called()


if __name__ == "__main__":
    unittest.main()
