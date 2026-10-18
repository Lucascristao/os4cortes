import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np

from processor.framing import Face, SpeakerContinuity, StableFraming
from processor import tracking


LEFT = Face(0.1, 0.2, 0.18, 0.22, 0.9, 0.0)
RIGHT = Face(0.65, 0.2, 0.14, 0.2, 0.9, 0.65)


class CandidateContinuityTests(unittest.TestCase):
    def test_missing_detections_do_not_complete_speaker_switch(self):
        framing = StableFraming(0.32, switch_hold=0.5)
        framing.observe([LEFT], 0.0)
        framing.observe([LEFT, RIGHT], 0.1)
        for timestamp in [0.2, 0.4, 0.6]:
            framing.observe([], timestamp)
        framing.observe([LEFT, RIGHT], 0.7)
        self.assertEqual(framing.target, LEFT)
        self.assertEqual(framing.candidate_since, 0.7)

        for timestamp in [0.8, 0.9, 1.0, 1.1, 1.21]:
            framing.observe([LEFT, RIGHT], timestamp)
        self.assertEqual(framing.target, RIGHT)

    def test_gap_is_expired_even_without_intermediate_observation(self):
        framing = StableFraming(0.32, switch_hold=0.5)
        framing.observe([LEFT], 0.0)
        framing.observe([LEFT, RIGHT], 0.1)
        framing.observe([LEFT, RIGHT], 0.7)
        self.assertEqual(framing.target, LEFT)
        self.assertEqual(framing.candidate_last_valid, 0.7)

    def test_lost_target_replacement_keeps_its_recent_candidate(self):
        framing = StableFraming(0.32, switch_hold=0.5)
        framing.observe([LEFT], 0.0)
        for timestamp in [1.0, 1.15, 1.3, 1.45, 1.6]:
            framing.observe([RIGHT], timestamp)
        self.assertEqual(framing.target, RIGHT)


class HorizontalSpeakerTests(unittest.TestCase):
    def test_low_fps_sampling_can_confirm_the_same_speaker(self):
        continuity = SpeakerContinuity()
        result = None
        for timestamp in [0.0, 0.4, 0.8, 1.2]:
            result = continuity.observe([RIGHT], timestamp, 0.4)
        self.assertEqual(result, RIGHT)

    def test_low_fps_missed_sample_requires_fresh_confirmation(self):
        continuity = SpeakerContinuity()
        continuity.observe([RIGHT], 0.0, 0.4)
        continuity.observe([RIGHT], 0.4, 0.4)
        self.assertIsNone(continuity.observe([RIGHT], 1.2, 0.4))
        self.assertAlmostEqual(continuity.streak, 0.4)

    def test_different_people_cannot_accumulate_one_speaker_streak(self):
        continuity = SpeakerContinuity()
        for i in range(40):
            speaker = LEFT if i % 2 else RIGHT
            self.assertIsNone(continuity.observe([speaker], i / 10, 0.1))
        self.assertAlmostEqual(continuity.streak, 0.1)

    def test_brief_reaction_does_not_move_confirmed_target(self):
        continuity = SpeakerContinuity()
        target = None
        for i in range(16):
            target = continuity.observe([LEFT], i / 10, 0.1) or target
        self.assertEqual(target, LEFT)

        for i in range(16, 21):
            target = continuity.observe([RIGHT], i / 10, 0.1) or target
        self.assertEqual(target, LEFT)

        for i in range(21, 32):
            target = continuity.observe([RIGHT], i / 10, 0.1) or target
        self.assertEqual(target, RIGHT)

    def test_short_pause_preserves_candidate(self):
        continuity = SpeakerContinuity(hold=0.5)
        for timestamp in [0.0, 0.1, 0.2]:
            self.assertIsNone(continuity.observe([RIGHT], timestamp, 0.1))
        continuity.observe([], 0.3, 0.1)
        self.assertEqual(continuity.candidate, RIGHT)
        result = None
        for timestamp in [0.4, 0.5, 0.6, 0.7]:
            result = continuity.observe([RIGHT], timestamp, 0.1)
        self.assertEqual(result, RIGHT)

    def test_long_gap_requires_fresh_confirmation(self):
        continuity = SpeakerContinuity(hold=0.5)
        continuity.observe([RIGHT], 0.0, 0.1)
        continuity.observe([RIGHT], 0.1, 0.1)
        self.assertIsNone(continuity.observe([RIGHT], 0.8, 0.1))
        self.assertAlmostEqual(continuity.streak, 0.1)

    def test_simultaneous_speakers_clear_candidate(self):
        continuity = SpeakerContinuity(hold=0.5)
        continuity.observe([RIGHT], 0.0, 0.1)
        self.assertIsNone(continuity.observe([LEFT, RIGHT], 0.1, 0.1))
        self.assertIsNone(continuity.candidate)
        self.assertEqual(continuity.streak, 0.0)


@unittest.skipIf(tracking.cv2 is None, "OpenCV não instalado")
class MouthHistoryTests(unittest.TestCase):
    def test_nearest_previous_mouth_is_independent_of_detector_order(self):
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        face = [40, 40, 10, 10]
        nearest = (0.45, 0.45, np.zeros((16, 24), dtype=np.uint8), 0.0)
        farther = (0.35, 0.45, np.full((16, 24), 255, dtype=np.uint8), 0.9)
        for previous in [[nearest, farther], [farther, nearest]]:
            score, _ = tracking.calcular_movimento_labial(frame, face, previous, 100, 100)
            self.assertEqual(score, 0.0)

    def test_detection_gap_clears_mouth_history_in_both_renderers(self):
        # Exercise the render loops through face -> missing -> face. The media
        # encoder is replaced; OpenCV still transforms real image arrays.
        for render in [tracking.render_tracking_9x16, tracking.render_cinematic_16x9]:
            with self.subTest(renderer=render.__name__), tempfile.TemporaryDirectory() as td:
                frame = np.zeros((36, 64, 3), dtype=np.uint8)
                cap = Mock()
                cap.isOpened.return_value = True
                cap.get.side_effect = lambda prop: {
                    tracking.cv2.CAP_PROP_FPS: 30.0,
                    tracking.cv2.CAP_PROP_FRAME_WIDTH: 64,
                    tracking.cv2.CAP_PROP_FRAME_HEIGHT: 36,
                }[prop]
                cap.read.side_effect = [(True, frame.copy()) for _ in range(3)] + [(False, None)]
                detector = Mock()
                face = np.array([[10, 5, 20, 20, 0.9]], dtype=np.float32)
                detector.detect.side_effect = [(0, face), (0, None), (0, face)]
                history_sizes = []

                def mouth_score(image, box, previous, width, height):
                    history_sizes.append(len(previous))
                    return 0.8, (0.3, 0.3, np.zeros((16, 24), dtype=np.uint8), 0.8)

                def start_encoder(command, **kwargs):
                    Path(command[-1]).touch()
                    return Mock(stdin=io.BytesIO(), returncode=0)

                with (
                    patch.object(tracking.cv2, "VideoCapture", return_value=cap),
                    patch.object(tracking.cv2.FaceDetectorYN, "create", return_value=detector),
                    patch.object(tracking, "garantir_yunet", return_value=Path(td) / "model.onnx"),
                    patch.object(tracking, "mudou_plano", return_value=(False, False)),
                    patch.object(tracking, "calcular_movimento_labial", side_effect=mouth_score),
                    patch.object(tracking.subprocess, "run"),
                    patch.object(tracking.subprocess, "Popen", side_effect=start_encoder),
                ):
                    render(
                        Path(td) / "source.mp4", 0, 0.1, Path(td) / "result.mp4", td,
                        largura_saida=32, altura_saida=32, detectar_a_cada=1,
                    )
                self.assertEqual(history_sizes, [0, 0])


if __name__ == "__main__":
    unittest.main()
