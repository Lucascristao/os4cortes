"""Recover visible faces without mistaking whole-face motion for speech."""
import unittest
from unittest.mock import patch

import numpy as np

from processor import framing, tracking
from processor.framing import Face, StableFraming


LEFT = Face(.1, .2, .16, .23, .95)
RIGHT = Face(.72, .2, .16, .23, .95)


class VisibleTargetRecoveryTests(unittest.TestCase):
    def test_replacement_is_confirmed_during_loss_hold_and_snaps_without_empty_pan(self):
        policy = StableFraming(.316)
        policy.observe([LEFT], 0)
        policy.position(0)
        recovered = None
        for n in range(1, 61):
            t = n / 30
            if n % 3 == 0:
                policy.observe([RIGHT], t)
            position = policy.position(t)
            if policy.target == RIGHT:
                recovered = t
                self.assertAlmostEqual(position, RIGHT.center)
                self.assertFalse(policy.needs_overview(t))
                break
        self.assertIsNotNone(recovered)
        self.assertLessEqual(recovered, 1.1)

    def test_brief_miss_keeps_crop_but_long_loss_preserves_whole_source(self):
        policy = StableFraming(.316)
        policy.observe([LEFT], 0)
        center = policy.position(0)
        policy.observe([], .1)
        self.assertFalse(policy.needs_overview(.1))
        policy.observe([], .4)
        self.assertTrue(policy.needs_overview(.4))
        self.assertEqual(policy.position(.4), center)
        policy.observe([], 10)
        self.assertTrue(policy.needs_overview(10))

    def test_new_shot_without_detection_cannot_reuse_old_crop(self):
        policy = StableFraming(.316)
        policy.observe([LEFT], 0)
        policy.reset_shot()
        policy.observe([], .1)
        self.assertTrue(policy.needs_overview(.1))
        policy.observe([RIGHT], .2)
        self.assertFalse(policy.needs_overview(.2))
        self.assertAlmostEqual(policy.position(.2), RIGHT.center)

    def test_reaction_from_two_listeners_does_not_replace_visible_speaker(self):
        policy = StableFraming(.316)
        speaker = Face(.1, .2, .16, .23, .95, .8)
        policy.observe([speaker], 0)
        for n in range(1, 31):
            # Different face positions/sizes, but no local mouth articulation.
            listeners = [Face(.40 + .01 * (n % 2), .2, .18, .24, .95, 0),
                         Face(.72, .2, .20, .26, .95, 0)]
            policy.observe([speaker, *listeners], n / 10)
            policy.position(n / 10)
        self.assertEqual(policy.target, speaker)
        self.assertFalse(policy.needs_overview(3))

    def test_sustained_new_speaker_can_take_focus_with_three_participants(self):
        policy = StableFraming(.316, switch_hold=.5)
        policy.observe([LEFT], 0)
        for n in range(1, 9):
            speaker = Face(.72, .2, .16, .23, .95, .8)
            listener = Face(.40, .2, .23, .30, .95, .05)
            policy.observe([LEFT, listener, speaker], n / 10)
            policy.position(n / 10)
        self.assertEqual(policy.target, speaker)
        self.assertFalse(policy.needs_overview(.8))


@unittest.skipIf(tracking.cv2 is None, "OpenCV não instalado")
class FaceMotionReferenceTests(unittest.TestCase):
    def test_whole_face_brightness_change_does_not_count_as_speech(self):
        box = [20, 10, 40, 60]
        black = np.zeros((100, 100, 3), np.uint8)
        _, previous = tracking.calcular_movimento_labial(black, box, [], 100, 100)
        lit = np.full_like(black, 60)
        score, _ = tracking.calcular_movimento_labial(lit, box, [previous], 100, 100)
        self.assertEqual(score, 0)

    def test_local_mouth_change_still_produces_activity(self):
        box = [20, 10, 40, 60]
        before = np.zeros((100, 100, 3), np.uint8)
        _, previous = tracking.calcular_movimento_labial(before, box, [], 100, 100)
        after = before.copy()
        after[46:67, 28:52] = 100
        score, _ = tracking.calcular_movimento_labial(after, box, [previous], 100, 100)
        self.assertGreater(score, .35)

    def test_shared_texture_shift_is_not_local_mouth_articulation(self):
        box = [20, 10, 40, 60]
        tile = np.random.default_rng(4).integers(0, 255, (8, 8), dtype=np.uint8)
        textured = np.tile(tile, (13, 13))[:100, :100]
        before = np.repeat(textured[:, :, None], 3, axis=2)
        _, previous = tracking.calcular_movimento_labial(before, box, [], 100, 100)
        after = np.roll(before, 2, axis=1)
        score, _ = tracking.calcular_movimento_labial(after, box, [previous], 100, 100)
        self.assertEqual(score, 0)

    def test_overview_preserves_both_edges_and_original_pixels(self):
        source = np.zeros((36, 64, 3), np.uint8)
        source[:, :32] = (0, 0, 255)
        source[:, 32:] = (255, 0, 0)
        original = source.copy()
        result = tracking.overview_frame(source, 18, 32)
        self.assertEqual(result.shape, (32, 18, 3))
        self.assertGreater(result[16, 0, 2], 240)
        self.assertGreater(result[16, -1, 0], 240)
        np.testing.assert_array_equal(source, original)


class FramingCacheTests(unittest.TestCase):
    def test_framing_version_invalidates_clip_but_not_narration_or_voice_plan(self):
        from processor import editorial_renderer as renderer
        from processor.editorial_plan import voice_plan_fingerprint
        common = dict(source_hash="source", canvas={}, lower_third={}, words=[])
        clip = {"id": "c", "kind": "clip", "start": 0, "end": 1}
        narration = {"id": "n", "kind": "narration", "text": "Uma observação."}
        plan = {"version": 1, "source": {"label": "Fonte", "date": ""},
                "scenes": [clip, {**narration, "background": {"start": 0, "end": 1},
                    "evidence": [{"start": 0, "end": 1}],
                    "visual": {"title": "UM PONTO", "kicker": "Tema", "lines": []},
                    "tts": {"delivery": "explain", "cues": []}}]}
        before = [renderer.scene_fingerprint(s, **common) for s in [clip, narration]]
        voice_before = voice_plan_fingerprint(plan)
        with patch.object(framing, "FRAMING_POLICY_VERSION", "next-framing-policy"):
            after = [renderer.scene_fingerprint(s, **common) for s in [clip, narration]]
            self.assertEqual(voice_before, voice_plan_fingerprint(plan))
        self.assertNotEqual(before[0], after[0])
        self.assertEqual(before[1], after[1])


if __name__ == "__main__":
    unittest.main()
