import copy
import json
import unittest
from unittest.mock import patch

from processor.render_batch import main, normalizar_cortes


def valid_plan():
    return {
        "version": 1,
        "source": {"label": "Entrevista original", "date": "2026-10-18"},
        "scenes": [
            {
                "id": "opening",
                "kind": "narration",
                "text": "O que essa resposta esclarece?",
                "background": {"start": 10, "end": 12},
                "visual": {"title": "O que foi dito?", "kicker": "Uma pergunta", "lines": ["Veja a resposta"]},
                "tts": {"delivery": "question", "cues": []},
                "evidence": [{"start": 12, "end": 18}],
            },
            {"id": "answer", "kind": "clip", "start": 12, "end": 18},
        ],
    }


def package(plan=None, *, include_editorial=True):
    cut = {"titulo": "Uma resposta", "inicio": "00:10", "fim": "00:20", "formato": "9:16", "saida_suave": False}
    if include_editorial:
        cut["editorial"] = valid_plan() if plan is None else plan
    return [cut]


class EditorialBatchContractTests(unittest.TestCase):
    def test_editorial_vertical_limit_counts_original_clips_without_narration_or_source_envelope(self):
        for duration, expected in ((179.9, "9:16"), (180, "9:16"), (180.1, "16:9")):
            cuts = package()
            cuts[0].update(inicio=0, fim=900, destino="reels_tiktok")
            cuts[0]["editorial"]["scenes"][0].update(
                text=("Uma observação própria que desenvolve a ideia da fonte. " * 20).strip(),
                background={"start": 880, "end": 900},
                evidence=[{"start": 880, "end": 900}],
            )
            cuts[0]["editorial"]["scenes"][1].update(start=10, end=10 + duration)
            with self.subTest(original_seconds=duration):
                result = normalizar_cortes(json.dumps(cuts))[0]
                self.assertEqual(result["formato"], expected)
                self.assertEqual(result["destino"], "youtube" if expected == "16:9" else "reels_tiktok")
                self.assertEqual(result["editorial"]["scenes"], cuts[0]["editorial"]["scenes"])

    def test_distant_references_and_long_narration_do_not_turn_short_original_into_youtube(self):
        cuts = package()
        cuts[0].update(inicio=0, fim=900)
        cuts[0]["editorial"]["scenes"][0].update(
            text="Uma contribuição completa, com começo, desenvolvimento e conclusão. " * 18,
            background={"start": 800, "end": 900},
            evidence=[{"start": 800, "end": 900}],
        )
        result = normalizar_cortes(json.dumps(cuts))[0]
        self.assertEqual((result["formato"], result["destino"]), ("9:16", "reels_tiktok"))

    def test_three_decimal_sixty_second_clips_remain_vertical_at_exactly_three_minutes(self):
        cuts = package()
        cuts[0].update(inicio=0, fim=300)
        cuts[0]["editorial"]["scenes"][1:] = [
            {"id": "first", "kind": "clip", "start": 10.1, "end": 70.1},
            {"id": "second", "kind": "clip", "start": 100.1, "end": 160.1},
            {"id": "third", "kind": "clip", "start": 200.1, "end": 260.1},
        ]
        result = normalizar_cortes(json.dumps(cuts))[0]
        self.assertEqual((result["formato"], result["destino"]), ("9:16", "reels_tiktok"))

    def test_replaying_the_same_hundred_seconds_twice_counts_as_two_hundred_original_seconds(self):
        cuts = package()
        cuts[0].update(inicio=0, fim=120)
        cuts[0]["editorial"]["scenes"][1:] = [
            {"id": "first", "kind": "clip", "start": 10, "end": 110},
            {"id": "replay", "kind": "clip", "start": 10, "end": 110},
        ]
        result = normalizar_cortes(json.dumps(cuts))[0]
        self.assertEqual((result["formato"], result["destino"]), ("16:9", "youtube"))

    def test_explicit_youtube_choice_is_preserved_for_a_shorter_complete_story(self):
        for routing in ({"formato": "16:9"}, {"destino": "youtube"}):
            cuts = package()
            cuts[0].update(routing)
            with self.subTest(routing=routing):
                result = normalizar_cortes(json.dumps(cuts))[0]
                self.assertEqual((result["formato"], result["destino"]), ("16:9", "youtube"))

    def test_simple_original_duration_preserves_three_minutes_and_routes_only_above_it(self):
        for duration, expected in ((180, "9:16"), (180.1, "16:9")):
            cuts = package(include_editorial=False)
            cuts[0].update(inicio=0, fim=duration)
            with self.subTest(original_seconds=duration):
                result = normalizar_cortes(json.dumps(cuts))[0]
                self.assertEqual(result["formato"], expected)
                self.assertEqual(result["destino"], "youtube" if expected == "16:9" else "reels_tiktok")

    def test_incidental_editorial_plan_does_not_override_the_selected_simple_mode(self):
        cuts = package()
        cuts[0].update(inicio=0, fim=600)
        raw = json.dumps(cuts)
        simple = normalizar_cortes(raw, cut_mode="simple")[0]
        editorial = normalizar_cortes(raw, cut_mode="editorial")[0]
        self.assertEqual((simple["formato"], simple["destino"]), ("16:9", "youtube"))
        self.assertEqual((editorial["formato"], editorial["destino"]), ("9:16", "reels_tiktok"))
        self.assertEqual(simple["editorial"], editorial["editorial"])
        self.assertEqual(normalizar_cortes(raw)[0]["formato"], "9:16")

    def test_legacy_normalization_does_not_add_editorial_or_change_the_existing_fields(self):
        result = normalizar_cortes(json.dumps(package(include_editorial=False)))[0]
        self.assertEqual(result, {
            "titulo": "Uma resposta", "inicio": 10.0, "fim": 20.0,
            "formato": "9:16", "destino": "reels_tiktok", "descricao": "",
            "legenda_post": "", "hashtags": "", "tags": "", "saida_suave": False,
        })

    def test_mixed_package_keeps_the_validated_plan_only_on_the_opted_in_cut(self):
        cuts = package() + package(include_editorial=False)
        result = normalizar_cortes(json.dumps(cuts, ensure_ascii=False))
        self.assertEqual(result[0]["editorial"], valid_plan())
        self.assertNotIn("editorial", result[1])
        self.assertFalse(result[0]["saida_suave"])

    def test_editing_cut_bounds_invalidates_clips_backgrounds_and_evidence_outside_the_selection(self):
        for key in ("clip", "background", "evidence"):
            plan = valid_plan()
            if key == "clip":
                plan["scenes"][1]["end"] = 21
            else:
                target = plan["scenes"][0][key][0] if key == "evidence" else plan["scenes"][0][key]
                target["start"] = 9
            with self.subTest(reference=key), self.assertRaisesRegex(ValueError, "Corte 1:.*fora do corte selecionado"):
                normalizar_cortes(json.dumps(package(plan)))

    def test_invalid_contracts_are_rejected_with_cut_context(self):
        cases = []
        for raw in (None, [], "invalid", {"version": 2}, {"version": True}):
            cuts = package()
            cuts[0]["editorial"] = raw
            cases.append(cuts)
        for modify in (
            lambda plan: plan["scenes"][0].update(evidence=[]),
            lambda plan: plan["scenes"][1].update(id="opening"),
            lambda plan: plan["scenes"][0]["tts"].update(delivery="improvise"),
            lambda plan: plan["scenes"][0]["tts"].update(cues=[{"text": "Palavras ausentes"}]),
            lambda plan: plan["scenes"][0].update(kind="command"),
        ):
            plan = valid_plan()
            modify(plan)
            cases.append(package(plan))
        for cuts in cases:
            with self.subTest(editorial=cuts[0]["editorial"]), self.assertRaisesRegex(ValueError, "Corte 1: editorial"):
                normalizar_cortes(json.dumps(cuts))

    def test_invalid_plan_stops_before_uploader_download_tracking_or_synthesis(self):
        invalid = copy.deepcopy(valid_plan())
        invalid["scenes"][1]["end"] = 25
        args = [
            "render_batch", "--request-id", "test", "--folder-id", "folder",
            "--video-file-id", "video", "--transcript-json-file-id", "transcript",
            "--cuts-json", json.dumps(package(invalid)),
            "--workdir", ".work-invalid-plan-test", "--output", ".output-invalid-plan-test",
        ]
        # No disk or service access is needed to verify rejection before media processing.
        with patch("sys.argv", args), patch("processor.render_batch.Path.mkdir"), \
                patch("processor.render_batch.shutil.rmtree"), \
                patch("processor.render_batch.uploader_por_env") as uploader, \
                patch("processor.render_batch.start_heartbeat") as heartbeat, \
                patch("processor.render_batch.failed") as failed:
            with self.assertRaisesRegex(ValueError, "Corte 1:.*fora do corte selecionado"):
                main()
            uploader.assert_not_called()
            failed.assert_called_once()
            heartbeat.return_value.set.assert_called_once()


if __name__ == "__main__":
    unittest.main()
