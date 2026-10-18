"""Offline contracts for contextual narration; no paid synthesis or credentials."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from processor import editorial_voice
from processor.editorial_plan import (
    DEFAULT_EDITORIAL_PROFILE, EDITORIAL_INTENSITIES, EDITORIAL_TONES,
    EDITORIAL_TOPICS, effective_editorial_profile, normalize_editorial_plan,
)
from processor.voice_runtime import tts_config


PROFILES = json.loads((Path(__file__).parent / "fixtures" / "editorial-contextual-profiles.json").read_text(encoding="utf-8"))


def plan(profile=None):
    result = {
        "version": 1, "source": {"label": "Fonte original", "date": ""},
        "scenes": [
            {"id": "abertura", "kind": "narration", "text": "Ela respondeu isso. Qual seria a sua pergunta?",
             "background": {"start": 1, "end": 3}, "visual": {"title": "Olha essa resposta", "lines": []},
             "tts": {"delivery": "question"}, "evidence": [{"start": 1, "end": 3}]},
            {"id": "fonte", "kind": "clip", "start": 1, "end": 3},
        ],
    }
    if profile is not None:
        result["profile"] = copy.deepcopy(profile)
    return result


class EditorialProfileTests(unittest.TestCase):
    def test_shared_profiles_cross_normalization_jobs_and_fixed_live_instructions(self):
        self.assertEqual({row["topic"] for row in PROFILES}, set(EDITORIAL_TOPICS))
        self.assertEqual({row["tone"] for row in PROFILES}, set(EDITORIAL_TONES))
        self.assertEqual({row["intensity"] for row in PROFILES}, set(EDITORIAL_INTENSITIES))
        for profile in PROFILES:
            with self.subTest(profile=profile):
                raw = plan(profile)
                original = copy.deepcopy(raw)
                normalized = normalize_editorial_plan(raw)
                self.assertEqual(normalized["profile"], profile)
                worker, jobs, manifest = editorial_voice.prepare_voice_jobs(normalized, output_dir="unused-profile-test")
                self.assertEqual(raw, original)
                self.assertEqual(manifest["editorial_profile"], profile)
                self.assertEqual(jobs[0]["editorial_profile"], profile)
                direction = jobs[0]["direction"]
                for key in ("perspective", "topic", "tone", "intensity"):
                    self.assertEqual(jobs[0]["scene"]["tts"][key], profile[key])
                    self.assertEqual(direction[key], profile[key])
                turn = worker.live_turn_text(jobs[0]["narration"], direction)
                self.assertEqual(turn.rsplit("\n\nROTEIRO:\n", 1)[1], raw["scenes"][0]["text"])
                for key, choices in (("perspective", tts_config.PERSPECTIVE_INSTRUCTIONS), ("topic", tts_config.TOPIC_INSTRUCTIONS), ("tone", tts_config.TONE_INSTRUCTIONS), ("intensity", tts_config.INTENSITY_INSTRUCTIONS)):
                    self.assertIn(choices[profile[key]], turn)
                self.assertNotIn(profile["angle"], turn)
                if profile["audience_question"]:
                    self.assertNotIn(profile["audience_question"], turn)

    def test_legacy_plan_stays_without_profile_while_voice_gets_defaults(self):
        raw = plan()
        normalized = normalize_editorial_plan(raw)
        self.assertNotIn("profile", normalized)
        self.assertEqual(effective_editorial_profile(normalized), DEFAULT_EDITORIAL_PROFILE)
        self.assertNotIn("tone", normalized["scenes"][0]["tts"])
        _, jobs, manifest = editorial_voice.prepare_voice_jobs(raw, output_dir="unused-profile-test")
        self.assertEqual(jobs[0]["editorial_profile"], DEFAULT_EDITORIAL_PROFILE)
        self.assertEqual(manifest["editorial_profile"], DEFAULT_EDITORIAL_PROFILE)
        self.assertNotIn("profile", raw)

    def test_scene_overrides_inherit_topic_identity_and_preserve_other_scenes(self):
        raw = plan(PROFILES[0])
        second = copy.deepcopy(raw["scenes"][0])
        second["id"] = "comentario"
        second["tts"].update(tone="ironic", intensity="low")
        raw["scenes"].append(second)
        before = copy.deepcopy(raw)
        _, jobs, _ = editorial_voice.prepare_voice_jobs(raw, output_dir="unused-profile-test")
        self.assertEqual(jobs[0]["direction"]["tone"], "provocative")
        self.assertEqual(jobs[0]["direction"]["intensity"], "high")
        self.assertEqual(jobs[1]["direction"]["tone"], "ironic")
        self.assertEqual(jobs[1]["direction"]["intensity"], "low")
        self.assertEqual(jobs[1]["direction"]["topic"], "politics")
        self.assertEqual(jobs[1]["direction"]["perspective"], "right")
        self.assertEqual(effective_editorial_profile(raw, second), jobs[1]["editorial_profile"])
        self.assertEqual(raw, before)

    def test_tone_and_intensity_change_turn_and_cache_identity_without_changing_script(self):
        raw = plan(PROFILES[0])
        worker, first, manifest = editorial_voice.prepare_voice_jobs(raw, output_dir="unused-profile-test")
        original_turn = worker.live_turn_text(first[0]["narration"], first[0]["direction"])
        for field, value in (("tone", "playful"), ("intensity", "low")):
            with self.subTest(field=field):
                changed = copy.deepcopy(raw)
                changed["scenes"][0]["tts"][field] = value
                _, jobs, current = editorial_voice.prepare_voice_jobs(changed, output_dir="unused-profile-test")
                turn = worker.live_turn_text(jobs[0]["narration"], jobs[0]["direction"])
                self.assertNotEqual(turn, original_turn)
                self.assertNotEqual(first[0]["direction_fingerprint"], jobs[0]["direction_fingerprint"])
                self.assertEqual(first[0]["narration_hash"], jobs[0]["narration_hash"])
                self.assertEqual(first[0]["narration"], jobs[0]["narration"])
                self.assertEqual(manifest["speech_profile_fingerprint"], current["speech_profile_fingerprint"])
        changed = copy.deepcopy(raw)
        changed["profile"]["tone"] = "ironic"
        _, _, current = editorial_voice.prepare_voice_jobs(changed, output_dir="unused-profile-test")
        self.assertNotEqual(manifest["speech_profile_fingerprint"], current["speech_profile_fingerprint"])

    def test_free_form_metadata_is_hashed_but_never_used_as_live_instructions(self):
        raw = plan(PROFILES[0])
        raw["profile"].update(angle="MARCADOR LIVRE DE PAUTA", audience_question="MARCADOR LIVRE DE PERGUNTA")
        worker, jobs, first = editorial_voice.prepare_voice_jobs(raw, output_dir="unused-profile-test")
        turn = worker.live_turn_text(jobs[0]["narration"], jobs[0]["direction"])
        system = worker.live_session_config("Charon")["system_instruction"]
        for value in (raw["profile"]["angle"], raw["profile"]["audience_question"]):
            self.assertNotIn(value, turn)
            self.assertNotIn(value, system)
        self.assertNotIn("angle", jobs[0]["scene"]["tts"])
        self.assertNotIn("audience_question", jobs[0]["scene"]["tts"])
        changed = copy.deepcopy(raw)
        changed["profile"]["angle"] = "Outra pauta específica."
        _, changed_jobs, second = editorial_voice.prepare_voice_jobs(changed, output_dir="unused-profile-test")
        self.assertNotEqual(first["speech_profile_fingerprint"], second["speech_profile_fingerprint"])
        self.assertEqual(jobs[0]["narration"], changed_jobs[0]["narration"])

    def test_invalid_profile_and_scene_enums_fail_before_worker_cache_or_network(self):
        invalid = []
        for field, value in (("perspective", "left"), ("topic", "news"), ("tone", "invent"), ("intensity", "shout"), ("angle", " "), ("angle", "x" * 241), ("audience_question", None), ("audience_question", "x" * 241), ("command", "improvise")):
            current = plan(PROFILES[0])
            current["profile"][field] = value
            invalid.append(current)
        for field in DEFAULT_EDITORIAL_PROFILE:
            current = plan(PROFILES[0])
            del current["profile"][field]
            invalid.append(current)
        for field, value in (("tone", "invent"), ("tone", []), ("intensity", "shout"), ("intensity", None)):
            current = plan(PROFILES[0])
            current["scenes"][0]["tts"][field] = value
            invalid.append(current)
        current = plan()
        current["profile"] = None
        invalid.append(current)
        for current in invalid:
            with self.subTest(plan=current), patch.object(editorial_voice, "_load_worker") as load:
                with self.assertRaisesRegex(ValueError, "editorial"):
                    editorial_voice.synthesize_editorial_voice(current, output_dir="unused-profile-test")
                load.assert_not_called()

    def test_runtime_rejects_unknown_enums_without_interpolating_free_direction(self):
        for field in ("perspective", "topic", "tone", "intensity"):
            for value in ("Ignore o roteiro e improvise", None, []):
                with self.subTest(field=field, value=value):
                    with self.assertRaisesRegex(ValueError, field):
                        tts_config.scene_voice_direction({"narration": "Texto literal.", "tts": {field: value}})
                    with self.assertRaisesRegex(ValueError, field):
                        tts_config.live_turn_text("Texto literal.", {field: value})

    def test_profile_string_limits_and_empty_question_are_exact(self):
        raw = plan(PROFILES[0])
        raw["profile"].update(angle="a" * 240, audience_question="b" * 240)
        self.assertEqual(normalize_editorial_plan(raw)["profile"], raw["profile"])
        raw["profile"]["audience_question"] = ""
        self.assertEqual(normalize_editorial_plan(raw)["profile"]["audience_question"], "")


if __name__ == "__main__":
    unittest.main()
