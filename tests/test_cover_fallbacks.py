"""Regressions for real-scene fallbacks when face detection or decoding fails."""
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import numpy as np
from PIL import Image

from processor import covers
from processor.lower_third import LowerThird


SCENE_REASON = "no_usable_face_detected_using_scene_frame"


def scene_photo():
    """The two edge subjects reveal an accidental center-only crop."""
    pixels = np.full((900, 1600, 3), 115, dtype=np.uint8)
    pixels[:, :240] = (240, 25, 25)
    pixels[:, -240:] = (25, 25, 240)
    return Image.fromarray(pixels)


class FakeCapture:
    def __init__(self, frame=None):
        self.frame = frame
        self.released = False

    def isOpened(self):
        return self.frame is not None

    def set(self, *_args):
        return True

    def read(self):
        return (True, self.frame.copy()) if self.frame is not None else (False, None)

    def release(self):
        self.released = True


def cv2_without_native_decoder(capture):
    """Keep these boundary tests runnable without a local OpenCV installation."""
    def imdecode(data, _mode):
        try:
            with Image.open(io.BytesIO(data.tobytes())) as image:
                return np.asarray(image.convert("RGB"))[:, :, ::-1].copy()
        except (OSError, ValueError):
            return None

    return SimpleNamespace(
        VideoCapture=MagicMock(return_value=capture),
        CAP_PROP_POS_MSEC=0,
        COLOR_BGR2RGB=1,
        IMREAD_COLOR=1,
        cvtColor=lambda frame, _code: frame[:, :, ::-1].copy(),
        resize=lambda frame, size: np.asarray(Image.fromarray(frame).resize(size)).copy(),
        absdiff=lambda left, right: np.abs(left.astype(np.int16)-right.astype(np.int16)).astype(np.uint8),
        imdecode=imdecode,
    )


class CoverSceneFallbackTests(unittest.TestCase):
    def setUp(self):
        covers._FRAME_SELECTION_CACHE.clear()

    def tearDown(self):
        covers._FRAME_SELECTION_CACHE.clear()

    def test_total_decode_failure_is_an_error_and_writes_no_image_or_report(self):
        capture = FakeCapture()
        cv2 = cv2_without_native_decoder(capture)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/"unreadable.mp4"
            source.write_bytes(b"invalid video fixture")
            output = root/"cut_capa.jpg"
            with patch.object(covers, "_cv2", return_value=cv2), \
                    patch.object(covers, "_extract_frame_ffmpeg", return_value=None):
                with self.assertRaisesRegex(covers.CoverError, "extrair.*frame"):
                    covers.render_cover(source, [(2, 3)], output, title="O QUE MUDOU?",
                                        work_dir=root/"cache", max_candidates=1)
            self.assertTrue(capture.released)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.rglob("*.jpg")), [])
            self.assertEqual(list(root.rglob("*.json")), [])
            self.assertEqual(covers._FRAME_SELECTION_CACHE, {})

    def test_no_face_keeps_both_edge_subjects_in_the_sharp_scene_panel(self):
        photo = scene_photo()
        selection = {"faces": [], "framing": "scene", "pair_in_same_frame": False,
                     "fallback_reason": SCENE_REASON, "timestamp": 2.5}
        for aspect, expected in (("9:16", "01_central"), ("16:9", "02_lateral")):
            for template in covers.TEMPLATE_IDS:
                with self.subTest(aspect=aspect, requested=template):
                    image, report = covers.compose_cover(
                        photo, selection, aspect=aspect,
                        cover={"version": 1, "template_id": template, "title": "AÇÃO E REAÇÃO?"})
                    self.assertEqual(report["requested_template"], template)
                    self.assertEqual(report["applied_template"], expected)
                    self.assertEqual(report["framing"], "scene")
                    self.assertEqual(report["fallback_reason"], SCENE_REASON)
                    self.assertEqual(len(report["crops"]), 1)
                    crop = report["crops"][0]
                    self.assertEqual(crop["source_crop"], [0, 0, photo.width, photo.height])
                    self.assertIsNone(crop["face_box"])
                    left, top, right, bottom = crop["destination"]
                    self.assertGreater(right-left, 0)
                    self.assertGreater(bottom-top, 0)
                    self.assertAlmostEqual((right-left)/(bottom-top), photo.width/photo.height, delta=.004)
                    # Inspect only the reported sharp panel: its blurred background
                    # must not disguise the loss of either edge of the real frame.
                    panel = np.asarray(image.crop((left, top, right, bottom))).astype(np.int16)
                    third = max(1, panel.shape[1]//3)
                    red = panel[:, :third]
                    blue = panel[:, -third:]
                    red_pixels = (red[:, :, 0] > 2*red[:, :, 1]) & (red[:, :, 0] > 2*red[:, :, 2])
                    blue_pixels = (blue[:, :, 2] > 2*blue[:, :, 0]) & (blue[:, :, 2] > 2*blue[:, :, 1])
                    self.assertGreater(float(red_pixels.mean()), .10)
                    self.assertGreater(float(blue_pixels.mean()), .10)
                    self.assertIn("typography", report)
                    self.assertIn("badge_box", report)

    def test_valid_scene_without_faces_is_cached_across_aspects_and_uses_configured_ffmpeg(self):
        capture = FakeCapture()
        cv2 = cv2_without_native_decoder(capture)
        raw = np.asarray(scene_photo())[:, :, ::-1].copy()
        executable = "custom-tools/ffmpeg-source-decoder"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/"source.mp4"
            source.write_bytes(b"video decoded by injected FFmpeg fixture")
            with patch.object(covers, "_cv2", return_value=cv2), \
                    patch.object(covers, "_extract_frame_ffmpeg", return_value=raw) as extract, \
                    patch.object(covers, "_make_detector", return_value=lambda _frame: []) as make_detector:
                vertical = covers.render_cover(
                    source, [(2, 3)], root/"vertical_capa.jpg", title="O QUE MUDOU?", aspect="9:16",
                    ffmpeg=executable, work_dir=root/"cache", max_candidates=1)
                first_extractions = extract.call_count
                self.assertGreater(first_extractions, 0)
                for call in extract.call_args_list:
                    passed_executable = call.kwargs.get("ffmpeg", call.args[2] if len(call.args) > 2 else None)
                    self.assertEqual(passed_executable, executable)
                horizontal = covers.render_cover(
                    source, [(2, 3)], root/"horizontal_capa.jpg", title="O QUE MUDOU?", aspect="16:9",
                    ffmpeg=executable, work_dir=root/"cache", max_candidates=1)
                self.assertEqual(extract.call_count, first_extractions)
                self.assertEqual(cv2.VideoCapture.call_count, 1)
                self.assertEqual(make_detector.call_count, 1)
            for report in (vertical, horizontal):
                self.assertTrue(Path(report["path"]).is_file())
                self.assertEqual(report["selection"]["faces"], [])
                self.assertEqual(report["selection"]["framing"], "scene")
                self.assertEqual(report["selection"]["fallback_reason"], SCENE_REASON)
                self.assertEqual(report["fallback_reason"], SCENE_REASON)
                self.assertEqual(report["selection"]["source_size"], [1600, 900])
                self.assertEqual(report["selection"]["timestamp"], 2.5)

    def test_opencv_decoded_scene_also_retains_real_frame_without_fake_face(self):
        raw = np.asarray(scene_photo())[:, :, ::-1].copy()
        capture = FakeCapture(raw)
        cv2 = cv2_without_native_decoder(capture)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/"source.mp4"
            source.write_bytes(b"source fixture")
            with patch.object(covers, "_cv2", return_value=cv2), \
                    patch.object(covers, "_extract_frame_ffmpeg") as ffmpeg:
                photo, selection = covers._select_frame(
                    source, [(2, 3)], LowerThird(), Path(tmp), detector=lambda _frame: [], max_candidates=1)
            ffmpeg.assert_not_called()
            self.assertEqual(photo.size, (1600, 900))
            np.testing.assert_array_equal(np.asarray(photo), raw[:, :, ::-1])
            self.assertEqual(selection["faces"], [])
            self.assertEqual(selection["framing"], "scene")
            self.assertEqual(selection["fallback_reason"], SCENE_REASON)
            self.assertFalse(selection["active_speaker"])

    def test_ffmpeg_frame_extraction_runs_the_configured_binary_and_decodes_its_pixels(self):
        buffer = io.BytesIO()
        scene_photo().save(buffer, format="JPEG", quality=95, subsampling=0)
        cv2 = cv2_without_native_decoder(FakeCapture())
        proc = SimpleNamespace(returncode=0, stdout=buffer.getvalue())
        executable = "custom-tools/ffmpeg-real-frame"
        with patch.object(covers, "_cv2", return_value=cv2), \
                patch.object(covers.subprocess, "run", return_value=proc) as run:
            frame = covers._extract_frame_ffmpeg("source.mp4", 2.5, ffmpeg=executable)
        self.assertIsNotNone(frame)
        self.assertEqual(frame.shape, (900, 1600, 3))
        command = run.call_args.args[0]
        self.assertEqual(command[0], executable)
        self.assertEqual(command[command.index("-ss")+1], "2.500")
        self.assertEqual(command[command.index("-i")+1], "source.mp4")
        # FFmpeg yields BGR for the selector, not a blank fabricated image.
        self.assertGreater(int(frame[450, 80, 2]), 220)
        self.assertGreater(int(frame[450, 1520, 0]), 220)

    def test_multiple_detections_never_create_a_second_portrait_or_extra_confirmation_scan(self):
        raw = np.asarray(scene_photo())[:, :, ::-1].copy()
        primary = [
            {"box": [220, 160, 180, 240], "confidence": .99, "score": 1.0, "eye_detail": .9},
            {"box": [1160, 150, 200, 250], "confidence": .98, "score": .75, "eye_detail": .9},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/"source.mp4"
            source.write_bytes(b"foreground speaker and background face")
            for aspect in ("9:16", "16:9"):
                for identifier in (*covers.TEMPLATE_IDS, "04_duas_pessoas"):
                    with self.subTest(aspect=aspect, identifier=identifier):
                        cv2 = cv2_without_native_decoder(FakeCapture(raw))
                        detector = MagicMock(return_value=primary)
                        with patch.object(covers, "_cv2", return_value=cv2), \
                                patch.object(covers, "_quality", side_effect=lambda _frame, found: dict(found)), \
                                patch.object(covers, "_measure_activity", return_value=(
                                    {"mouth_activity": 0.0, "mouth_motion": 0.0, "head_motion": 0.0}, None, None)), \
                                patch.object(covers, "_layout_possible", return_value=True):
                            report = covers.render_cover(
                                source, [(2, 3)], root/f"{aspect.replace(':', 'x')}-{identifier}.jpg",
                                cover={"version": 1, "template_id": identifier, "title": "MUDOU?"},
                                aspect=aspect, detector=detector, max_candidates=1, work_dir=root/"cache")
                        detector.assert_called_once()
                        self.assertEqual(len(report["selection"]["faces"]), 1)
                        self.assertEqual(report["selection"]["faces"][0]["box"], primary[0]["box"])
                        self.assertEqual(len(report["crops"]), 1)
                        self.assertEqual(report["requested_template"], identifier)
                        expected = covers.default_template(aspect) if identifier == "04_duas_pessoas" else identifier
                        self.assertEqual(report["applied_template"], expected)
                        self.assertEqual(report["cover"]["template_id"], expected)
                        if identifier == "04_duas_pessoas":
                            self.assertEqual(report["fallback_reason"], "retired_two_person_template")
                        self.assertTrue(Path(report["path"]).is_file())


if __name__ == "__main__":
    unittest.main()
