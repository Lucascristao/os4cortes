import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from processor.covers import (
    ASSETS, CoverError, PRESETS, TEMPLATE_IDS, compose_cover,
    normalize_cover, render_cover, sample_timestamps,
)


class CoverContractTests(unittest.TestCase):
    def test_only_three_single_face_templates_and_six_packaged_presets_remain(self):
        self.assertEqual(TEMPLATE_IDS, ("01_central", "02_lateral", "03_close"))
        for aspect in ("9:16", "16:9"):
            self.assertEqual(set(PRESETS[aspect]), {"size", *TEMPLATE_IDS})
            self.assertTrue(all(len(PRESETS[aspect][key]["photos"]) == 1 for key in TEMPLATE_IDS))
        manifest = json.loads((ASSETS/"manifest-v1.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], PRESETS["version"])
        self.assertEqual(len(manifest["references"]), 6)
        for item in manifest["references"]:
            self.assertTrue((ASSETS/item["file"]).is_file())
            self.assertNotIn("04_duas_pessoas", item["file"])

    def test_retired_pair_is_migrated_for_each_aspect_without_mutating_legacy_title(self):
        raw = {"version": 1, "template_id": "04_duas_pessoas", "title": "AÇÃO E REAÇÃO?"}
        for aspect, expected in (("9:16", "01_central"), ("16:9", "02_lateral")):
            self.assertEqual(normalize_cover(raw, "Título de publicação", aspect),
                             {"version": 1, "template_id": expected, "title": "AÇÃO E REAÇÃO?"})
        self.assertEqual(raw["template_id"], "04_duas_pessoas")

    def test_legacy_defaults_and_unicode_title(self):
        self.assertEqual(normalize_cover(None, "AÇÃO E REAÇÃO?", "9:16"),
                         {"version": 1, "template_id": "01_central", "title": "AÇÃO E REAÇÃO?"})
        self.assertEqual(normalize_cover(None, "Título", "16:9")["template_id"], "02_lateral")
        self.assertEqual(normalize_cover({"version": 1, "template_id": "03_close", "title": "  SIM?  "}, "", "9:16")["title"], "SIM?")

    def test_invalid_contracts_fail_clearly_without_silently_truncating(self):
        valid = {"version": 1, "template_id": "01_central", "title": "TÍTULO"}
        invalid = [[], {}, {**valid, "other": 3}, {**valid, "version": True}, {**valid, "version": 2},
                   {**valid, "template_id": []}, {**valid, "template_id": "05"},
                   *({**valid, "title": value} for value in ("", " ", "a"*61, "<b>Oi</b>", "Olá\nMundo", "**Oi**", "`oi`", "[oi](x)", "oi\u2028sim"))]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(CoverError):
                normalize_cover(raw, "título", "9:16")
        with self.assertRaisesRegex(CoverError, "60 caracteres"):
            normalize_cover(None, "a"*61, "16:9")

    def test_samples_stay_in_union_of_source_ranges_and_are_deterministic(self):
        ranges = [(10, 20), (100, 105), (14, 21)]
        timestamps = sample_timestamps(ranges)
        self.assertEqual(timestamps, sample_timestamps(list(reversed(ranges))))
        self.assertLessEqual(len(timestamps), 60)
        self.assertTrue(all(10 <= timestamp < 21 or 100 <= timestamp < 105 for timestamp in timestamps))
        self.assertTrue(any(timestamp > 100 for timestamp in timestamps))
        self.assertEqual(len(sample_timestamps([(10, 10.01)])), 1)
        for intervals in ([], [(1, 1)], [(-1, 3)], [(False, 3)], [(1, float("inf"))]):
            with self.subTest(intervals=intervals), self.assertRaises(CoverError):
                sample_timestamps(intervals)


def _face(x=710, y=120, width=250, height=325, score=1):
    return {"box": [x, y, width, height], "score": score, "confidence": .99}


def _photo():
    # Different colors/texture expose accidental stretching or pasted blank areas.
    rng = np.random.default_rng(8)
    pixels = rng.integers(30, 210, (1080, 1920, 3), dtype=np.uint8)
    pixels[:, :960, 0] = 160
    pixels[:, 960:, 2] = 170
    return Image.fromarray(pixels)


class CoverCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.photo = _photo()

    def test_all_native_presets_keep_real_faces_free_of_text(self):
        for aspect in ("9:16", "16:9"):
            for identifier in TEMPLATE_IDS:
                selection = {"faces": [_face()]}
                with self.subTest(aspect=aspect, identifier=identifier):
                    image, report = compose_cover(self.photo, selection,
                                                  cover={"version": 1, "template_id": identifier, "title": "AÇÃO E REAÇÃO?"},
                                                  aspect=aspect, source_label="Fonte com acentos: São Luís")
                    self.assertEqual(image.size, tuple(PRESETS[aspect]["size"]))
                    self.assertEqual(report["applied_template"], identifier)
                    self.assertLessEqual(report["typography"]["line_count"], 1 if identifier == "03_close" else 2)
                    self.assertGreaterEqual(report["typography"]["font_size"], 70 if aspect == "16:9" else 48 if identifier == "03_close" else 50)
                    for crop in report["crops"]:
                        x, y, right, bottom = crop["source_crop"]
                        self.assertGreaterEqual(x, 0)
                        self.assertGreaterEqual(y, 0)
                        self.assertLessEqual(right, self.photo.width)
                        self.assertLessEqual(bottom, self.photo.height)
                        source_ratio = (right-x)/(bottom-y)
                        destination = crop["destination"]
                        self.assertAlmostEqual(source_ratio, (destination[2]-destination[0])/(destination[3]-destination[1]), places=5)
                    # Reports must travel through batch results without Path/numpy values.
                    json.dumps(report)

    def test_retired_pair_always_composes_one_face_even_when_source_has_two(self):
        for aspect, expected in (("9:16", "01_central"), ("16:9", "02_lateral")):
            _, report = compose_cover(self.photo, {"faces": [_face(), _face(1100)], "pair_in_same_frame": True},
                                      cover={"version": 1, "template_id": "04_duas_pessoas", "title": "O QUE MUDOU?"}, aspect=aspect)
            self.assertEqual(report["requested_template"], "04_duas_pessoas")
            self.assertEqual(report["applied_template"], expected)
            self.assertEqual(report["fallback_reason"], "retired_two_person_template")
            self.assertEqual(len(report["crops"]), 1)

    def test_close_long_title_falls_back_without_shrinking_below_floor(self):
        _, report = compose_cover(self.photo, {"faces": [_face()]},
                                  cover={"version": 1, "template_id": "03_close", "title": "QUEM VAI RESPONDER POR ESSA DECISÃO?"}, aspect="9:16")
        self.assertEqual(report["applied_template"], "01_central")
        self.assertEqual(report["fallback_reason"], "close_title_exceeds_readable_single_line")
        self.assertGreaterEqual(report["typography"]["font_size"], 50)
        with self.assertRaisesRegex(CoverError, "legibilidade"):
            compose_cover(self.photo, {"faces": [_face()]},
                          cover={"version": 1, "template_id": "01_central", "title": "W"*60}, aspect="9:16")

    def test_faces_at_different_positions_use_adaptive_crop(self):
        crops = []
        for face in (_face(100), _face(1400), _face(800, 320)):
            _, report = compose_cover(self.photo, {"faces": [face]},
                                      cover={"version": 1, "template_id": "01_central", "title": "POR QUÊ?"}, aspect="9:16")
            crops.append(report["crops"][0]["source_crop"])
        self.assertEqual(len({tuple(crop) for crop in crops}), 3)

    def test_cover_cache_is_independent_and_title_preflight_precedes_frame_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/"source.mp4"
            source.write_bytes(b"source media remains unchanged")
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            selection = {"faces": [_face()], "pair_in_same_frame": False, "timestamp": 2.5}
            with patch("processor.covers._select_frame", return_value=(self.photo, selection)) as select:
                first = render_cover(source, [(2, 3)], root/"first_capa.jpg", title="QUEM DECIDE?", work_dir=root/"cache")
                second = render_cover(source, [(2, 3)], root/"second_capa.jpg", title="QUEM DECIDE?", work_dir=root/"cache")
                self.assertEqual(select.call_count, 1)
                self.assertTrue(second["cache_hit"])
                self.assertEqual(first["sha256"], second["sha256"])
                changed = render_cover(source, [(2, 3)], root/"changed_capa.jpg", title="O QUE MUDOU?", work_dir=root/"cache")
                self.assertEqual(select.call_count, 2)
                self.assertNotEqual(first["cache_key"], changed["cache_key"])
                self.assertNotEqual(first["sha256"], changed["sha256"])
                with self.assertRaisesRegex(CoverError, "legibilidade"):
                    render_cover(source, [(2, 3)], root/"invalid.jpg", title="W"*60, work_dir=root/"cache")
                self.assertEqual(select.call_count, 2)
            self.assertEqual(before, hashlib.sha256(source.read_bytes()).hexdigest())

    def test_retired_template_migration_and_diagnostics_survive_cached_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/"source.mp4"
            source.write_bytes(b"source media")
            legacy = {"version": 1, "template_id": "04_duas_pessoas", "title": "O QUE MUDOU?"}
            for aspect, expected in (("9:16", "01_central"), ("16:9", "02_lateral")):
                with self.subTest(aspect=aspect), patch("processor.covers._select_frame", return_value=(
                        self.photo, {"faces": [_face(), _face(1100)], "timestamp": 2.5})) as select:
                    first = render_cover(source, [(2, 3)], root/"legacy.jpg", cover=legacy,
                                         aspect=aspect, work_dir=root/"cache")
                    direct = render_cover(source, [(2, 3)], root/"current.jpg",
                                          cover={**legacy, "template_id": expected}, aspect=aspect, work_dir=root/"cache")
                    cached = render_cover(source, [(2, 3)], root/"cached.jpg", cover=legacy,
                                          aspect=aspect, work_dir=root/"cache")
                    self.assertEqual(select.call_count, 2)
                    self.assertEqual(select.call_args.kwargs["template_id"], expected)
                    self.assertEqual(direct["requested_template"], expected)
                    self.assertEqual(first["sha256"], direct["sha256"])
                    self.assertTrue(cached["cache_hit"])
                    for report in (first, cached):
                        self.assertEqual(report["requested_template"], "04_duas_pessoas")
                        self.assertEqual(report["applied_template"], expected)
                        self.assertEqual(report["fallback_reason"], "retired_two_person_template")
                        self.assertEqual(report["cover"], {**legacy, "template_id": expected})
                        self.assertEqual(len(report["crops"]), 1)


if __name__ == "__main__":
    unittest.main()
