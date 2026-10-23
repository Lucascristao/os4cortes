"""Real PCM proof: shared narrator tone, source pitch and timeline integrity."""
import array
import hashlib
import math
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import wave

from processor.editorial_renderer import _master_audio, derive_narration


FFMPEG = os.environ.get("OS4_TEST_FFMPEG") or shutil.which("ffmpeg")
if (os.environ.get("CI") or os.environ.get("OS4_REQUIRE_FFMPEG") == "1") and not FFMPEG:
    raise RuntimeError("FFmpeg is required in CI for the real narration/source PCM proof.")


@unittest.skipUnless(FFMPEG, "Set OS4_TEST_FFMPEG or install ffmpeg for the real PCM check")
class EditorialMasterAudioTests(unittest.TestCase):
    def test_narrator_is_accelerated_once_and_half_semitone_lower_with_source_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "raw.wav", Path(folder) / "master.wav"
            samples = array.array("h", (round(5000*math.sin(2*math.pi*200*n/24000)) for n in range(48000)))
            with wave.open(str(source), "wb") as wav:
                wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                wav.writeframes(samples.tobytes())
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            canonical_words = [{"texto": "Uma", "inicio": .2, "fim": .6}, {"texto": "fala.", "inicio": .7, "fim": 2.0}]
            raw_info = {"path": source, "sha256": before, "duration": 2, "words": canonical_words}
            derived = derive_narration(raw_info, Path(folder) / "derived", ffmpeg=FFMPEG)
            self.assertFalse(derived["derived_cache_hit"])
            self.assertAlmostEqual(derived["duration"], 2/1.1, delta=.04)
            self.assertEqual(derived["words"][1]["fim"], 2/1.1)
            self.assertEqual(canonical_words[1]["fim"], 2.0)
            self.assertEqual(derived["timeline_duration"], max(derived["duration"], 2/1.1))
            cached = derive_narration(raw_info, Path(folder) / "derived", ffmpeg=FFMPEG)
            self.assertTrue(cached["derived_cache_hit"])
            self.assertEqual(cached["sha256"], derived["sha256"])
            changed = derive_narration(raw_info, Path(folder) / "derived", ffmpeg=FFMPEG, speed=1.05)
            self.assertNotEqual(changed["derived_key"], derived["derived_key"])
            self.assertNotEqual(changed["path"], derived["path"])
            records = [{"kind": "narration", "audio": derived["path"], "gain": 1, "duration": derived["duration"], "content_duration": derived["duration"]},
                       {"kind": "clip", "audio": source, "gain": 1, "duration": 2, "content_duration": 2},
                       {"kind": "narration", "audio": derived["path"], "gain": 1, "duration": derived["duration"], "content_duration": derived["duration"]}]
            _master_audio(records, output, ffmpeg=FFMPEG)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            with wave.open(str(output), "rb") as wav:
                self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (2, 2, 48000))
                self.assertAlmostEqual(wav.getnframes()/48000, 2+2*derived["duration"], delta=2/48000)
                data = array.array("h", wav.readframes(wav.getnframes()))[::2]
            def frequency(start):
                part = data[round((start+.4)*48000):round((start+1.4)*48000)]
                return sum(a <= 0 < b for a, b in zip(part, part[1:]))
            expected = 200*2**(-0.5/12)
            self.assertAlmostEqual(frequency(0), expected, delta=2)
            self.assertAlmostEqual(frequency(2+derived["duration"]), expected, delta=2)
            self.assertAlmostEqual(frequency(derived["duration"]), 200, delta=1)


if __name__ == "__main__":
    unittest.main()
