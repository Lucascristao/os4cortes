import copy
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

from processor.editorial_alignment import (
    ESTIMATED_BOUNDARY_SOURCE,
    VERSION,
    align_scene,
    build_vocabulary_prompt,
    cache_valid,
    canonical_words,
    fold_split_canonical_words,
    validate_manifest,
)


NARRATION = "Roberta diz que apresentou Lulinha a Antônio Camilo ontem."


def timed_observations(narration, omitted=(), duration_per_word=0.25):
    words = [word for index, word in enumerate(canonical_words(narration)) if index not in omitted]
    return [{"texto": word, "inicio": index * duration_per_word, "fim": (index + 1) * duration_per_word}
            for index, word in enumerate(words)]


class EditorialAlignmentTests(unittest.TestCase):
    def test_missing_prefix_is_rejected_even_when_coverage_is_above_the_gate(self):
        observations = timed_observations(NARRATION, omitted={0})
        _, diagnostics = align_scene(NARRATION, observations, 3)
        self.assertGreaterEqual(diagnostics["direct_coverage"], .85)
        self.assertFalse(diagnostics["passed"])
        self.assertTrue(any("sem duas âncoras" in error for error in diagnostics["failures"]))
        self.assertEqual(diagnostics["boundary_resolutions"], [])

    def test_lulinha_a_antonio_boundary_is_estimated_and_does_not_raise_direct_coverage(self):
        observations = timed_observations(NARRATION, omitted={5})
        original = copy.deepcopy(observations)
        words, diagnostics = align_scene(NARRATION, observations, 3)
        self.assertTrue(diagnostics["passed"], diagnostics["failures"])
        self.assertEqual([word["texto"] for word in words], canonical_words(NARRATION))
        self.assertAlmostEqual(diagnostics["direct_coverage"], 8 / 9, places=6)
        self.assertEqual(diagnostics["final_canonical_coverage"], 1.0)
        self.assertEqual(words[5]["texto"], "a")
        self.assertEqual(words[5]["timing_source"], ESTIMATED_BOUNDARY_SOURCE)
        self.assertTrue(words[5]["estimated"])
        self.assertEqual(words[5]["inicio"], words[4]["fim"])
        self.assertEqual(words[5]["fim"], words[6]["inicio"])
        self.assertGreaterEqual(words[4]["fim"] - words[4]["inicio"], .08)
        self.assertAlmostEqual(original[4]["fim"] - words[4]["fim"], .06)
        resolution = diagnostics["boundary_resolutions"][0]
        self.assertFalse(resolution["exact_asr_match"])
        self.assertFalse(resolution["audio_modified"])
        self.assertEqual(observations, original)

    def test_missing_noun_without_an_audio_interval_cannot_be_approved(self):
        observations = timed_observations(NARRATION, omitted={4})
        words, diagnostics = align_scene(NARRATION, observations, 3)
        self.assertGreaterEqual(diagnostics["direct_coverage"], .85)
        self.assertFalse(diagnostics["passed"])
        self.assertEqual(diagnostics["boundary_resolutions"], [])
        self.assertEqual(diagnostics["unresolved_word_count"], 1)
        self.assertNotIn("Lulinha", [word["texto"] for word in words])

    def test_short_anchor_donates_only_its_available_tail_and_preserves_80ms(self):
        observations = timed_observations(NARRATION, omitted={5}, duration_per_word=.1)
        words, diagnostics = align_scene(NARRATION, observations, 2)
        self.assertTrue(diagnostics["passed"], diagnostics["failures"])
        self.assertAlmostEqual(diagnostics["boundary_resolutions"][0]["borrowed_seconds"], .02)
        self.assertAlmostEqual(words[4]["fim"] - words[4]["inicio"], .08)

    def test_anchor_with_less_than_80ms_cannot_donate_time(self):
        observations = timed_observations(NARRATION, omitted={5}, duration_per_word=.07)
        _, diagnostics = align_scene(NARRATION, observations, 2)
        self.assertFalse(diagnostics["passed"])
        self.assertEqual(diagnostics["boundary_resolutions"], [])

    def test_boundary_resolution_never_bypasses_the_85_percent_gate(self):
        text = "Lulinha a Antônio"
        words, diagnostics = align_scene(text, timed_observations(text, omitted={1}), 2)
        self.assertEqual(len(words), 3)
        self.assertFalse(diagnostics["passed"])
        self.assertTrue(any("Cobertura direta" in error for error in diagnostics["failures"]))

    def test_large_gap_and_group_over_two_words_remain_rejected(self):
        observations = timed_observations(NARRATION, omitted={5})
        for word in observations[5:]:
            word["inicio"] += 2
            word["fim"] += 2
        _, diagnostics = align_scene(NARRATION, observations, 6)
        self.assertFalse(diagnostics["passed"])
        text = " ".join(f"termo{index}" for index in range(30))
        _, diagnostics = align_scene(text, timed_observations(text, omitted={7, 8, 9}), 10)
        self.assertGreaterEqual(diagnostics["direct_coverage"], .85)
        self.assertFalse(diagnostics["passed"])
        self.assertTrue(any("3 palavras" in error for error in diagnostics["failures"]))

    def test_only_one_joined_function_word_boundary_is_estimated_per_scene(self):
        text = "Roberta diz que apresentou Lulinha a Antônio Camilo e explicou tudo ontem para as pessoas presentes."
        expected = canonical_words(text)
        omitted = {expected.index("a"), expected.index("e")}
        _, diagnostics = align_scene(text, timed_observations(text, omitted=omitted), 6)
        self.assertGreaterEqual(diagnostics["direct_coverage"], .85)
        self.assertFalse(diagnostics["passed"])
        self.assertEqual(len(diagnostics["boundary_resolutions"]), 1)

    def test_spellings_are_folded_from_the_current_script_without_entity_specific_aliases(self):
        text = "Mariana apresentou a empresa Venturia durante a conversa de hoje."
        observations = timed_observations(text)
        word = observations[4]
        observations[4:5] = [
            {"texto": "Ven", "inicio": word["inicio"], "fim": word["inicio"] + .1},
            {"texto": "turia", "inicio": word["inicio"] + .1, "fim": word["fim"]},
        ]
        words, diagnostics = align_scene(text, observations, 4)
        self.assertTrue(diagnostics["passed"], diagnostics["failures"])
        self.assertEqual([word["texto"] for word in words], canonical_words(text))
        self.assertEqual(words[4]["timing_source"], "asr-span-joined-canonical-token")
        separate = timed_observations("a o ao")
        self.assertEqual(fold_split_canonical_words(separate, ["a", "o", "ao"]), separate)

    def test_vocabulary_prompt_is_short_and_derived_from_the_manifest(self):
        manifest = {"scenes": [{"narration": NARRATION}, {"narration": "Mas o que essa resposta esclarece?"}]}
        prompt = build_vocabulary_prompt(manifest)
        self.assertEqual(prompt, "Roberta, Lulinha, Antônio Camilo")
        self.assertNotIn(NARRATION, prompt)
        self.assertNotIn("Anvisa", prompt)
        self.assertLessEqual(len(prompt), 180)
        manifest["asr_vocabulary"] = [f"Empresa {index}" for index in range(30)]
        prompt = build_vocabulary_prompt(manifest)
        self.assertEqual(len(prompt.split(", ")), 12)
        self.assertLessEqual(len(prompt), 180)

    def test_permissive_mode_resolves_missing_prefix_and_passes(self):
        observations = timed_observations(NARRATION, omitted={0})
        words, diagnostics = align_scene(NARRATION, observations, 3, strict=False)
        self.assertTrue(diagnostics["passed"])
        self.assertEqual(len(words), len(canonical_words(NARRATION)))
        self.assertEqual(words[0]["texto"], "Roberta")
        self.assertEqual(words[0]["timing_source"], "estimated-prefix-span")
        self.assertAlmostEqual(words[0]["inicio"], 0.0)

    def test_permissive_mode_resolves_group_over_two_words_and_passes(self):
        text = "A conversa chegou à escala seis por um."
        words_canon = canonical_words(text)
        sim_asr = [
            {"texto": "A", "inicio": 0.0, "fim": 0.2},
            {"texto": "conversa", "inicio": 0.2, "fim": 0.6},
            {"texto": "chegou", "inicio": 0.6, "fim": 1.0},
            {"texto": "à", "inicio": 1.0, "fim": 1.2},
            {"texto": "escala", "inicio": 1.2, "fim": 1.6},
            {"texto": "6x1", "inicio": 1.6, "fim": 2.2},
        ]
        words, diagnostics = align_scene(text, sim_asr, 3.0, strict=False)
        self.assertTrue(diagnostics["passed"])
        self.assertEqual(len(words), len(words_canon))
        self.assertEqual([w["texto"] for w in words], words_canon)
        self.assertEqual(diagnostics["unresolved_word_count"], 0)

    def test_permissive_mode_resolves_missing_suffix_and_passes(self):
        expected = canonical_words(NARRATION)
        observations = timed_observations(NARRATION, omitted={len(expected) - 1})
        words, diagnostics = align_scene(NARRATION, observations, 3, strict=False)
        self.assertTrue(diagnostics["passed"])
        self.assertEqual(len(words), len(expected))
        self.assertEqual(words[-1]["texto"], expected[-1])
        self.assertEqual(words[-1]["timing_source"], "estimated-suffix-span")



class AlignmentManifestTests(unittest.TestCase):
    def fixture(self):
        observations = timed_observations(NARRATION)
        words, diagnostics = align_scene(NARRATION, observations, 3)
        scene = {"id": "any-safe-scene-id", "file": "scene.wav", "narration": NARRATION,
                 "narration_sha256": hashlib.sha256(NARRATION.encode()).hexdigest(),
                 "audio_sha256": "approved-audio-hash", "output_fidelity": {"passed": True}}
        manifest = {"status": "success", "scenes": [scene]}
        cached = {**scene, "coverage": diagnostics["direct_coverage"], "palavras": words, "diagnostics": diagnostics}
        cache = {"version": VERSION, "status": "success", "asr_model": "base",
                 "initial_prompt": build_vocabulary_prompt(manifest), "scenes": [cached]}
        return manifest, cache

    def test_generic_scene_count_and_new_version_are_required_for_cache(self):
        manifest, cache = self.fixture()
        with patch("processor.editorial_alignment.sha256_file", return_value="approved-audio-hash"), \
                patch("processor.editorial_alignment.audio_duration", return_value=3):
            self.assertTrue(cache_valid(cache, manifest, Path.cwd(), "base"))
            cache["version"] = "os4-canonical-word-alignment-v2-vocabulary-prompt"
            self.assertFalse(cache_valid(cache, manifest, Path.cwd(), "base"))

    def test_tts_fidelity_failure_is_not_replaced_by_asr_or_caption_resolution(self):
        manifest, cache = self.fixture()
        manifest["scenes"][0]["output_fidelity"]["passed"] = False
        with patch("processor.editorial_alignment.sha256_file") as read_audio:
            with self.assertRaisesRegex(ValueError, "Fidelidade de conteúdo TTS não aprovada"):
                validate_manifest(manifest, Path.cwd())
            self.assertFalse(cache_valid(cache, manifest, Path.cwd(), "base"))
            read_audio.assert_not_called()

    def test_modified_canonical_text_or_vocabulary_invalidates_cache(self):
        manifest, cache = self.fixture()
        with patch("processor.editorial_alignment.sha256_file", return_value="approved-audio-hash"), \
                patch("processor.editorial_alignment.audio_duration", return_value=3):
            cache["scenes"][0]["palavras"][0]["texto"] = "Texto trocado"
            self.assertFalse(cache_valid(cache, manifest, Path.cwd(), "base"))
            manifest, cache = self.fixture()
            manifest["asr_vocabulary"] = ["Outro termo"]
            self.assertFalse(cache_valid(cache, manifest, Path.cwd(), "base"))


if __name__ == "__main__":
    unittest.main()
