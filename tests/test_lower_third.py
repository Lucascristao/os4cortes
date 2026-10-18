import math
import unittest
from dataclasses import FrozenInstanceError

import numpy as np

from processor.lower_third import LowerThird, fit_crop_size


class LowerThirdTests(unittest.TestCase):
    def test_off_returns_the_original_frame_without_changing_geometry(self):
        frame = np.arange(7 * 12 * 3, dtype=np.uint8).reshape((7, 12, 3))
        treatment = LowerThird()
        self.assertIs(treatment.apply(frame), frame)
        self.assertEqual(treatment.content_height(7), 7)

    def test_off_ignores_an_otherwise_valid_height(self):
        frame = np.ones((10, 16, 3), dtype=np.uint8)
        treatment = LowerThird("off", 0.60)
        self.assertIs(treatment.apply(frame), frame)
        self.assertEqual(treatment.content_height(10), 10)

    def test_cover_rounds_up_band_and_does_not_mutate_source(self):
        frame = np.full((7, 12, 3), 210, dtype=np.uint8)
        source = frame.copy()
        treatment = LowerThird("cover", 0.20)
        result = treatment.apply(frame)
        self.assertEqual(treatment.content_height(7), 5)
        self.assertEqual(result.shape, frame.shape)
        self.assertFalse(np.shares_memory(result, frame))
        np.testing.assert_array_equal(frame, source)
        np.testing.assert_array_equal(result[:5], source[:5])
        self.assertTrue(np.all(result[5:] == 0))

    def test_crop_excludes_full_band_and_returns_view(self):
        frame = np.full((13, 20, 3), 100, dtype=np.uint8)
        frame[10:] = 255
        treatment = LowerThird("crop", 0.20)
        result = treatment.apply(frame)
        self.assertEqual(treatment.content_height(13), 10)
        self.assertEqual(result.shape, (10, 20, 3))
        self.assertTrue(np.shares_memory(result, frame))
        self.assertTrue(np.all(result == 100))
        self.assertTrue(np.all(frame[10:] == 255))

    def test_tiniest_positive_fraction_still_covers_one_row(self):
        treatment = LowerThird("cover", 0.00001)
        self.assertEqual(treatment.content_height(1080), 1079)

    def test_boundary_fraction_is_accepted(self):
        self.assertEqual(LowerThird("crop", 0.60).content_height(1080), 432)

    def test_treatment_is_immutable(self):
        treatment = LowerThird("cover", 0.20)
        with self.assertRaises(FrozenInstanceError):
            treatment.mode = "off"

    def test_invalid_modes_are_rejected(self):
        for mode in ("", "COVER", "blur", None, True):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                LowerThird(mode, 0.20)

    def test_invalid_fractions_are_rejected_even_when_off(self):
        for fraction in (-0.01, 0.60001, math.nan, math.inf, -math.inf, True, False, "0.20", None):
            with self.subTest(fraction=fraction), self.assertRaises(ValueError):
                LowerThird("off", fraction)

    def test_active_treatment_requires_a_positive_fraction(self):
        for mode in ("cover", "crop"):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                LowerThird(mode, 0.0)

    def test_invalid_source_heights_are_rejected(self):
        for height in (0, -1, 1.5, True, None):
            with self.subTest(height=height), self.assertRaises(ValueError):
                LowerThird("cover", 0.20).content_height(height)


class CropGeometryTests(unittest.TestCase):
    def test_both_formats_fit_the_same_safe_source_area(self):
        safe_h = LowerThird("crop", 0.20).content_height(1080)
        self.assertEqual(safe_h, 864)
        self.assertEqual(fit_crop_size(1920, safe_h, 9 / 16), (486, 864))
        self.assertEqual(fit_crop_size(1920, safe_h, 16 / 9), (1536, 864))

    def test_portrait_source_can_be_reframed_for_youtube_without_squeezing(self):
        self.assertEqual(fit_crop_size(1080, 1536, 16 / 9), (1080, 608))

    def test_arbitrary_bounds_fit_with_at_most_half_a_pixel_rounding(self):
        for width, height in ((1921, 799), (101, 203), (600, 301)):
            for aspect in (9 / 16, 16 / 9):
                with self.subTest(width=width, height=height, aspect=aspect):
                    crop_w, crop_h = fit_crop_size(width, height, aspect)
                    self.assertTrue(1 <= crop_w <= width)
                    self.assertTrue(1 <= crop_h <= height)
                    self.assertTrue(crop_w == width or crop_h == height)
                    if crop_h == height:
                        self.assertLessEqual(abs(crop_w - crop_h * aspect), 0.5)
                    else:
                        self.assertLessEqual(abs(crop_h - crop_w / aspect), 0.5)

    def test_tiny_bounds_never_return_empty_dimensions(self):
        for aspect in (9 / 16, 16 / 9, 0.0001, 10000):
            with self.subTest(aspect=aspect):
                self.assertEqual(fit_crop_size(1, 1, aspect), (1, 1))

    def test_invalid_bounds_are_rejected(self):
        for dimension in (0, -1, 1.5, True, None):
            for width, height in ((dimension, 1080), (1920, dimension)):
                with self.subTest(width=width, height=height), self.assertRaises(ValueError):
                    fit_crop_size(width, height, 16 / 9)

    def test_invalid_aspects_are_rejected(self):
        for aspect in (0, -1, math.nan, math.inf, -math.inf, True, "1.77", None):
            with self.subTest(aspect=aspect), self.assertRaises(ValueError):
                fit_crop_size(1920, 1080, aspect)


if __name__ == "__main__":
    unittest.main()
