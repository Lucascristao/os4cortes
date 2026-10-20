import unittest

import numpy as np

from processor.cover_faces import confirm_pair_faces, _confirmation_crop


def face(x, y, width=60, height=90):
    return {"box": [x, y, width, height], "confidence": .72,
            "landmarks": [[x+width*.25, y+height*.35], [x+width*.70, y+height*.35],
                          [x+width*.48, y+height*.56], [x+width*.30, y+height*.76],
                          [x+width*.65, y+height*.76]]}


def translate(record, left, top):
    x, y, width, height = record["box"]
    return {**record, "box": [x-left, y-top, width, height],
            "landmarks": [[x-left, y-top] for x, y in record["landmarks"]]}


class PairFaceConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.frame = np.zeros((360, 640, 3), dtype=np.uint8)

    def test_confirms_two_lower_confidence_faces_without_requiring_high_confidence(self):
        records = [face(90, 80), face(440, 70)]
        expected_views = [_confirmation_crop(self.frame, record["box"]) for record in records]
        calls = []

        def detector(crop):
            index = len(calls)
            calls.append(crop)
            _, left, top = expected_views[index]
            self.assertAlmostEqual(crop.shape[1]/crop.shape[0], 640/360, delta=.01)
            return [translate(records[index], left, top)]

        result = confirm_pair_faces(self.frame, records, detector)
        self.assertEqual(len(calls), 2)
        self.assertEqual([item["box"] for item in result], [item["box"] for item in records])
        self.assertTrue(all(item["pair_verified"] for item in result))
        self.assertEqual(result[0]["pair_confirmation"]["confidence"], .72)
        self.assertNotIn("pair_verified", records[0])

    def test_print_that_disappears_at_confirmation_scale_is_excluded_only_from_pair(self):
        actual, print_pattern = face(290, 40), face(160, 250, 30, 45)
        records = [actual, print_pattern]
        _, left, top = _confirmation_crop(self.frame, actual["box"])
        responses = iter([[translate(actual, left, top)], []])
        result = confirm_pair_faces(self.frame, records, lambda crop: next(responses))
        self.assertEqual([item["box"] for item in result], [actual["box"]])
        self.assertEqual(len(records), 2, "single-face fallback candidates must remain intact")

    def test_nearby_actual_face_cannot_confirm_a_pattern_at_another_position(self):
        pattern = face(100, 100)
        other = face(160, 100)
        _, left, top = _confirmation_crop(self.frame, pattern["box"])
        self.assertEqual(confirm_pair_faces(self.frame, [pattern],
                                           lambda crop: [translate(other, left, top)]), [])

    def test_degenerate_secondary_landmarks_do_not_confirm(self):
        candidate = face(100, 100)
        _, left, top = _confirmation_crop(self.frame, candidate["box"])
        invalid = translate(candidate, left, top)
        invalid["landmarks"] = [[30, 30]]*5
        self.assertEqual(confirm_pair_faces(self.frame, [candidate], lambda crop: [invalid]), [])

    def test_frame_edge_padding_keeps_coordinates_and_face_size(self):
        candidate = face(-5, 0, 100, 150)
        crop, left, top = _confirmation_crop(self.frame, candidate["box"])
        self.assertLess(left, 0)
        self.assertLess(top, 0)
        result = confirm_pair_faces(self.frame, [candidate], lambda image: [translate(candidate, left, top)])
        self.assertEqual([item["box"] for item in result], [candidate["box"]])

    def test_optional_verifier_failure_uses_single_face_fallback(self):
        def broken_detector(crop):
            raise RuntimeError("extra detection failed")
        candidate = face(100, 100)
        self.assertEqual(confirm_pair_faces(self.frame, [candidate], broken_detector), [])

    def test_invalid_primary_does_not_run_detector(self):
        candidate = face(100, 100)
        candidate["landmarks"] = [[100, 100]]*5
        def never(crop):
            self.fail("invalid candidate should not reach the confirmation pass")
        self.assertEqual(confirm_pair_faces(self.frame, [candidate], never), [])


if __name__ == "__main__":
    unittest.main()
