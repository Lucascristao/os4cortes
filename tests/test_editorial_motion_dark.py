"""Motion Dark smoke tests: explicit catalogue, true animated Line MD and opt-in safety."""
import copy
import tempfile
from pathlib import Path
import unittest

from processor.covers import TITLE_FONT
from processor.editorial_plan import normalize_editorial_plan, voice_plan_fingerprint
from processor.editorial_visuals import Canvas
from processor.editorial_motion_dark import (
    _icon_frame, _background, dark_overlay, motion_dark_sequence, ICON_NAMES,
)
from processor.editorial_paper import video_box


def example():
    return {
        "version":1, "source":{"label":"Entrevista","date":""},
        "scenes":[
            {"id":"fala","kind":"narration","text":"Ela confirmou o assunto.",
             "background":{"start":1,"end":3},
             "visual":{"title":"A resposta confirma?","kicker":"CONTEXTO",
                       "lines":["O que ela confirma", "O que ficou sem resposta"],
                       "motion":{"layout":"comparison","icon":"line-md:confirm-circle",
                                 "emphasis":"confirma"}},
             "tts":{"delivery":"explain","cues":[]},
             "evidence":[{"start":1,"end":3}]},
            {"id":"origem","kind":"clip","start":1,"end":3}
        ]
    }


class MotionDarkTests(unittest.TestCase):
    def test_validated_catalogue_and_voice_cache(self):
        source = example()
        original = copy.deepcopy(source)
        original["scenes"][0]["visual"].pop("motion")
        plain = normalize_editorial_plan(original)
        dynamic = normalize_editorial_plan({**source, "visual_style":"motion_dark"})
        self.assertEqual(dynamic["visual_style"], "motion_dark")
        self.assertEqual(dynamic["scenes"][0]["visual"]["motion"]["layout"], "comparison")
        self.assertEqual(voice_plan_fingerprint(plain), voice_plan_fingerprint(dynamic))
        for key,value in [("icon","line-md:does-not-exist"),("layout","freeform")]:
            wrong = copy.deepcopy(source)
            wrong["scenes"][0]["visual"]["motion"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "motion"):
                normalize_editorial_plan(wrong)
        wrong = copy.deepcopy(source)
        wrong["scenes"][0]["visual"]["motion"]["emphasis"] = "NÃO FOI DITO"
        with self.assertRaisesRegex(ValueError, "emphasis"):
            normalize_editorial_plan(wrong)

    def test_icon_files_and_real_stroke_animation(self):
        from processor.editorial_motion_dark import ASSETS
        for name in ICON_NAMES:
            self.assertTrue((ASSETS/(name + ".svg")).is_file())
            start = _icon_frame(name, 96, 0)
            end = _icon_frame(name, 96, 30)
            self.assertEqual(start.size, (96,96))
            self.assertNotEqual(start.tobytes(), end.tobytes())

    def test_layers_transparency_and_light(self):
        canvas=Canvas.for_format(width=360)
        scene=example()["scenes"][0]
        front=dark_overlay(scene,canvas=canvas,font_path=TITLE_FONT,stage=-1)
        vx,vy,vw,vh=video_box(canvas)
        self.assertEqual(front.getpixel((vx+vw//2,vy+vh//2))[3],0)
        self.assertEqual(front.getpixel((0,0))[3],255)
        self.assertNotEqual(_background(canvas.width,canvas.height).getpixel((50,100)),
                            _background(canvas.width,canvas.height).getpixel((300,580)))
        replacement=dark_overlay(scene,canvas=canvas,font_path=TITLE_FONT,stage=0)
        self.assertEqual(replacement.getpixel((vx+vw//2,vy+vh//2))[3],255)
        self.assertNotEqual(front.tobytes(),replacement.tobytes())

    def test_frames_bounded_and_hold(self):
        with tempfile.TemporaryDirectory() as d:
            canvas=Canvas.for_format(width=360)
            scene=example()["scenes"][0]
            concat, events = motion_dark_sequence(
                scene, d, canvas=canvas,font_path=TITLE_FONT,duration=6)
            self.assertTrue(concat.exists())
            self.assertGreater(len(events),1)
            pngs=list(Path(d).glob("*.png"))
            self.assertLess(len(pngs),100)
            durations=[float(s.split()[1]) for s in concat.read_text().splitlines() if s.startswith("duration ")]
            self.assertAlmostEqual(sum(durations),6,places=6)


if __name__=="__main__":
    unittest.main()
