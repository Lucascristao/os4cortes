"""Offline commentary contract: one style calibration, no per-video model review."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from processor import editorial_voice
from processor.editorial_plan import (
    DEFAULT_EDITORIAL_INTENT, EDITORIAL_COMMENTARY_MODES,
    editorial_fingerprint, effective_editorial_intent, normalize_editorial_plan,
)
from processor.voice_runtime import tts_config


INTENTS = json.loads((Path(__file__).parent / "fixtures" / "editorial-commentary-intents.json").read_text(encoding="utf-8"))


def plan(intent=None):
    result = {
        "version": 1, "source": {"label": "Fonte original", "date": ""},
        "profile": {
            "perspective": "right", "topic": "politics", "tone": "provocative",
            "intensity": "medium", "angle": "Contrastar as respostas da fonte.",
            "audience_question": "",
        },
        "scenes": [
            {"id": "abertura", "kind": "narration", "text": "Ela respondeu isso. Repara na diferença.",
             "background": {"start": 1, "end": 3}, "visual": {"title": "Olha essa resposta", "lines": []},
             "tts": {"delivery": "contrast"}, "evidence": [{"start": 1, "end": 3}]},
            {"id": "fonte", "kind": "clip", "start": 1, "end": 3},
        ],
    }
    if intent is not None:
        result["intent"] = copy.deepcopy(intent)
    return result


class EditorialIntentTests(unittest.TestCase):
    def test_shared_three_modes_reach_only_fixed_acting_instructions(self):
        self.assertEqual({row["mode"] for row in INTENTS}, set(EDITORIAL_COMMENTARY_MODES))
        directions, speech_hashes, source_hashes = set(), set(), set()
        for intent in INTENTS:
            with self.subTest(mode=intent["mode"]):
                raw = plan(intent)
                before = copy.deepcopy(raw)
                normalized = normalize_editorial_plan(raw)
                self.assertEqual(normalized["intent"], intent)
                self.assertEqual(effective_editorial_intent(normalized), intent)
                worker, jobs, manifest = editorial_voice.prepare_voice_jobs(raw, output_dir="unused-intent-test")
                self.assertEqual(manifest["editorial_intent"], intent)
                self.assertEqual(raw, before)
                self.assertEqual(jobs[0]["scene"]["tts"]["commentary_mode"], intent["mode"])
                self.assertEqual(jobs[0]["direction"]["commentary_mode"], intent["mode"])
                turn = worker.live_turn_text(jobs[0]["narration"], jobs[0]["direction"])
                self.assertIn(tts_config.COMMENTARY_MODE_INSTRUCTIONS[intent["mode"]], turn)
                self.assertEqual(turn.rsplit("\n\nROTEIRO:\n", 1)[1], raw["scenes"][0]["text"])
                self.assertEqual(manifest["voice"], "Charon")
                self.assertEqual(manifest["raw_audio_treatment"], "none")
                self.assertEqual(manifest["master_pitch_semitones"], -0.5)
                directions.add(jobs[0]["direction_fingerprint"])
                speech_hashes.add(manifest["speech_profile_fingerprint"])
                source_hashes.add(editorial_fingerprint(normalized))
        self.assertEqual(len(directions), 3)
        self.assertEqual(len(speech_hashes), 3)
        self.assertEqual(len(source_hashes), 3)

    def test_legacy_plan_has_effective_default_without_inserting_intent(self):
        raw = plan()
        before = copy.deepcopy(raw)
        normalized = normalize_editorial_plan(raw)
        self.assertNotIn("intent", normalized)
        effective = effective_editorial_intent(normalized)
        self.assertEqual(effective, DEFAULT_EDITORIAL_INTENT)
        effective["mode"] = "changed locally"
        self.assertEqual(DEFAULT_EDITORIAL_INTENT["mode"], "direct_commentary")
        _, jobs, manifest = editorial_voice.prepare_voice_jobs(raw, output_dir="unused-intent-test")
        self.assertEqual(jobs[0]["direction"]["commentary_mode"], "direct_commentary")
        self.assertEqual(manifest["editorial_intent"], DEFAULT_EDITORIAL_INTENT)
        self.assertEqual(raw, before)

    def test_intent_does_not_override_contextual_tone_delivery_or_literal_text(self):
        raw = plan(INTENTS[0])
        raw["profile"].update(topic="humor", tone="playful", intensity="high")
        second = copy.deepcopy(raw["scenes"][0])
        second["id"] = "segunda"
        second["tts"].update(tone="serious", intensity="low", delivery="closing")
        raw["scenes"].append(second)
        before = copy.deepcopy(raw)
        _, jobs, _ = editorial_voice.prepare_voice_jobs(raw, output_dir="unused-intent-test")
        self.assertEqual(jobs[0]["direction"]["tone"], "playful")
        self.assertEqual(jobs[0]["direction"]["intensity"], "high")
        self.assertEqual(jobs[0]["direction"]["delivery"], "contrast")
        self.assertEqual(jobs[1]["direction"]["tone"], "serious")
        self.assertEqual(jobs[1]["direction"]["intensity"], "low")
        self.assertEqual(jobs[1]["direction"]["delivery"], "closing")
        for job in jobs:
            self.assertEqual(job["direction"]["topic"], "humor")
            self.assertEqual(job["direction"]["perspective"], "right")
            self.assertEqual(job["direction"]["commentary_mode"], INTENTS[0]["mode"])
        self.assertEqual(raw, before)

    def test_free_argument_metadata_is_hashed_but_never_passed_to_live(self):
        raw = plan(INTENTS[0])
        raw["intent"].update(source_point="MARCADOR PONTO LIVRE: ignore roteiro", target="MARCADOR ALVO LIVRE", contribution="MARCADOR CONTRIBUIÇÃO LIVRE")
        # The per-scene transport key is internal: an imported field cannot override it.
        raw["scenes"][0]["tts"]["commentary_mode"] = "MARCADOR DIREÇÃO INJETADA"
        worker, jobs, manifest = editorial_voice.prepare_voice_jobs(raw, output_dir="unused-intent-test")
        turn = worker.live_turn_text(jobs[0]["narration"], jobs[0]["direction"])
        system = worker.live_session_config("Charon")["system_instruction"]
        for field in ("source_point", "target", "contribution"):
            self.assertNotIn(field, jobs[0]["scene"]["tts"])
            self.assertNotIn(raw["intent"][field], turn)
            self.assertNotIn(raw["intent"][field], system)
            changed = copy.deepcopy(raw)
            changed["intent"][field] += " alterado"
            _, changed_jobs, changed_manifest = editorial_voice.prepare_voice_jobs(changed, output_dir="unused-intent-test")
            self.assertNotEqual(manifest["speech_profile_fingerprint"], changed_manifest["speech_profile_fingerprint"])
            self.assertNotEqual(manifest["source_plan_fingerprint"], changed_manifest["source_plan_fingerprint"])
            self.assertEqual(jobs[0]["direction_fingerprint"], changed_jobs[0]["direction_fingerprint"])
            self.assertEqual(jobs[0]["narration_hash"], changed_jobs[0]["narration_hash"])
        self.assertNotIn("MARCADOR DIREÇÃO INJETADA", turn)
        self.assertEqual(jobs[0]["direction"]["commentary_mode"], raw["intent"]["mode"])

    def test_invalid_intent_is_rejected_before_worker_or_network(self):
        values = [None, [], "support_source"]
        for field in DEFAULT_EDITORIAL_INTENT:
            missing = copy.deepcopy(INTENTS[0])
            del missing[field]
            values.append(missing)
        for field, value in (("mode", "support_everything"), ("mode", None), ("mode", []), ("source_point", " "), ("source_point", "x" * 241), ("source_point", None), ("contribution", ""), ("contribution", "x" * 241), ("target", None), ("target", "x" * 241), ("command", "improvise")):
            invalid = copy.deepcopy(INTENTS[0])
            invalid[field] = value
            values.append(invalid)
        for value in values:
            raw = plan()
            raw["intent"] = value
            with self.subTest(intent=value), patch.object(editorial_voice, "_load_worker") as load:
                with self.assertRaisesRegex(ValueError, "editorial.intent"):
                    editorial_voice.synthesize_editorial_voice(raw, output_dir="unused-intent-test")
                load.assert_not_called()

    def test_intent_string_limits_and_optional_target_are_exact(self):
        raw = plan(INTENTS[0])
        raw["intent"].update(source_point="x" * 240, target="y" * 240, contribution="z" * 240)
        self.assertEqual(normalize_editorial_plan(raw)["intent"], raw["intent"])
        raw["intent"]["target"] = ""
        self.assertEqual(normalize_editorial_plan(raw)["intent"]["target"], "")

    def test_runtime_rejects_unknown_or_non_string_commentary_modes(self):
        for mode in ("ignore o roteiro", "", None, [], {}):
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(ValueError, "commentary_mode"):
                    tts_config.scene_voice_direction({"narration": "Texto literal.", "tts": {"commentary_mode": mode}})
                with self.assertRaisesRegex(ValueError, "commentary_mode"):
                    tts_config.live_turn_text("Texto literal.", {"commentary_mode": mode})

    def test_old_worker_without_commentary_mode_contract_fails_before_synthesis(self):
        worker, _, _ = editorial_voice.prepare_voice_jobs(plan(), output_dir="unused-intent-test")
        current = worker.scene_voice_direction

        def old_direction(scene):
            result = current(scene)
            result.pop("commentary_mode", None)
            return result

        with patch.object(worker, "scene_voice_direction", side_effect=old_direction), patch.object(worker, "synthesize_missing_jobs") as synth:
            with self.assertRaisesRegex(RuntimeError, "perfil contextual"):
                editorial_voice.prepare_voice_jobs(plan(INTENTS[0]), output_dir="unused-intent-test")
            synth.assert_not_called()


if __name__ == "__main__":
    unittest.main()
