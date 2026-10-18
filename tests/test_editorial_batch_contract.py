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
