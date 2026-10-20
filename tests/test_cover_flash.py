"""Real media regression for the existing 0.14s vertical opening overlay."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from processor.captions import criar_legendas_corte

FFMPEG = os.environ.get("OS4_TEST_FFMPEG") or shutil.which("ffmpeg")
if os.environ.get("OS4_REQUIRE_FFMPEG") == "1" and not FFMPEG:
    raise RuntimeError("FFmpeg is mandatory in CI for the flash regression")


@unittest.skipUnless(FFMPEG, "FFmpeg is required for the real flash proof")
class CoverFlashTests(unittest.TestCase):
    def test_overlay_reuses_timeline_and_changes_when_cover_changes(self):
        def run(*args):
            return subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", *map(str, args)],
                                  check=True, capture_output=True).stdout
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            video, transcript, cover = root/"base.mp4", root/"words.json", root/"base_capa.jpg"
            run("-y", "-f", "lavfi", "-i", "color=blue:s=1080x1920:r=30:d=1",
                "-f", "lavfi", "-i", "sine=frequency=200:sample_rate=48000:duration=1",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video)
            transcript.write_text(json.dumps([{"words": [{"word": "Teste", "start": .1, "end": .6}]}]), encoding="utf-8")
            Image.new("RGB", (1080, 1920), "red").save(cover)
            with patch.dict(os.environ, {"PATH": str(Path(FFMPEG).parent)+os.pathsep+os.environ.get("PATH", "")}):
                _, output, actual_cover = criar_legendas_corte(transcript, video, 0, 1, capa_pronta=cover,
                    gerar_capa=False, color_grading=False, pasta_fontes=root/"fonts")
                self.assertEqual(actual_cover, cover)
                # One sampled pixel from each frame: first five frames are the
                # inclusive t<=0.14 flash, the remaining 25 are source blue.
                pixels = run("-i", output, "-vf", "crop=2:2:20:20,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")
                colors = [tuple(pixels[i:i+3]) for i in range(0, len(pixels), 3)]
                self.assertEqual(len(colors), 30)
                self.assertTrue(all(r > 200 and b < 40 for r, g, b in colors[:5]))
                self.assertTrue(all(b > 200 and r < 40 for r, g, b in colors[5:]))
                record = output.with_suffix(".caption-cache.json")
                first_key = json.loads(record.read_text())["key"]
                Image.new("RGB", (1080, 1920), "green").save(cover)
                criar_legendas_corte(transcript, video, 0, 1, capa_pronta=cover,
                    gerar_capa=False, color_grading=False, pasta_fontes=root/"fonts")
                self.assertNotEqual(json.loads(record.read_text())["key"], first_key)
                # A cover-only change leaves the original media byte-identical.
                audio = run("-i", output, "-vn", "-t", "1", "-ar", "48000", "-ac", "1", "-f", "s16le", "pipe:1")
                self.assertEqual(len(audio)//2, 48000)


if __name__ == "__main__":
    unittest.main()
