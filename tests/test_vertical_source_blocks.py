"""Source-block policy is independent of total duration, camera and voice cache."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from processor.editorial_plan import longest_source_block_seconds, validate_vertical_source_blocks
from processor.editorial_renderer import render_editorial_cut


def clip(start, end):
    return {"kind": "clip", "start": start, "end": end}


class VerticalSourceBlocksTests(unittest.TestCase):
    def test_exact_boundary_and_decimal_source_timestamps(self):
        for scenes, seconds, valid in (
            ([clip(1.1, 56.1)], 55, True),
            ([clip(0, 55.001)], 55.001, False),
            ([clip(1.1, 26.2), clip(100, 129.9)], 55, True),
            ([clip(0, 30), clip(100, 130)], 60, False),
            ([clip(0, 30), clip(0, 30)], 60, False),
        ):
            with self.subTest(scenes=scenes):
                plan = {"scenes": scenes}
                self.assertEqual(longest_source_block_seconds(plan), seconds)
                if valid:
                    validate_vertical_source_blocks(plan, "9:16")
                else:
                    with self.assertRaisesRegex(ValueError, "55s"):
                        validate_vertical_source_blocks(plan, "9:16")
                validate_vertical_source_blocks(plan, "16:9")

    def test_narration_separates_blocks_without_limiting_total(self):
        narration = {"kind": "narration", "background": {"start": 0, "end": 900},
                     "evidence": [{"start": 0, "end": 900}]}
        plan = {"scenes": [clip(0, 55), narration, clip(100, 155), narration, clip(200, 255)]}
        self.assertEqual(longest_source_block_seconds(plan), 55)
        validate_vertical_source_blocks(plan, "9:16")
        # A trailing narration cannot rescue an earlier overlong source block.
        with self.assertRaisesRegex(ValueError, "55s"):
            validate_vertical_source_blocks({"scenes": [clip(0, 60), narration]}, "9:16")

    def test_direct_renderer_rejects_before_reading_source_or_buying_voice(self):
        plan = {"scenes": [clip(0, 60), {"kind": "narration"}]}
        with tempfile.TemporaryDirectory() as folder, \
             patch("pathlib.Path.is_file", return_value=True), \
             patch("processor.editorial_renderer.normalize_editorial_plan", return_value=plan), \
             patch("processor.editorial_renderer.captions.carregar_palavras") as source, \
             patch("processor.editorial_renderer._ensure_voice_bundle") as voice:
            with self.assertRaisesRegex(ValueError, "55s"):
                render_editorial_cut("source.mp4", "transcript.json", plan,
                                    Path(folder)/"out.mp4", work_dir=Path(folder)/"work")
            source.assert_not_called()
            voice.assert_not_called()


if __name__ == "__main__":
    unittest.main()
