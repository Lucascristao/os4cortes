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

from processor.editorial_renderer import _master_audio


FFMPEG = os.environ.get("OS4_TEST_FFMPEG") or shutil.which("ffmpeg")


@unittest.skipUnless(FFMPEG, "Set OS4_TEST_FFMPEG or install ffmpeg for the real PCM check")
class EditorialMasterAudioTests(unittest.TestCase):
    def test_narrator_is_one_semitone_lower_with_source_and_duration_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "raw.wav", Path(folder) / "master.wav"
            samples = array.array("h", (round(5000*math.sin(2*math.pi*200*n/24000)) for n in range(48000)))
            with wave.open(str(source), "wb") as wav:
                wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                wav.writeframes(samples.tobytes())
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            records = [{"kind": kind, "audio": source, "gain": 1, "duration": 2, "content_duration": 2}
                       for kind in ("narration", "clip", "narration")]
            _master_audio(records, output, ffmpeg=FFMPEG)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            with wave.open(str(output), "rb") as wav:
                self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (2, 2, 48000))
                self.assertEqual(wav.getnframes(), 6*48000)
                data = array.array("h", wav.readframes(wav.getnframes()))[::2]
            def frequency(start):
                part = data[round((start+.5)*48000):round((start+1.5)*48000)]
                return sum(a <= 0 < b for a, b in zip(part, part[1:]))
            expected = 200*2**(-1/12)
            self.assertAlmostEqual(frequency(0), expected, delta=2)
            self.assertAlmostEqual(frequency(4), expected, delta=2)
            self.assertAlmostEqual(frequency(2), 200, delta=1)


if __name__ == "__main__":
    unittest.main()
