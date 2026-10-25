"""Motion Dark smoke tests: explicit catalogue, true animated Line MD and opt-in safety."""
import copy
import hashlib
import shutil
import subprocess
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

    def test_black_dark_palette_has_true_black_corners_and_local_lighting(self):
        canvas = Canvas.for_format(width=360)
        backdrop = _background(canvas.width, canvas.height)
        self.assertEqual(backdrop.getpixel((0, 0)), (0, 0, 0, 255))
        self.assertEqual(backdrop.getpixel((canvas.width-1, canvas.height-1)), (0, 0, 0, 255))
        glow = backdrop.getpixel((round(canvas.width*.28), round(canvas.height*.26)))
        self.assertGreater(glow[0], 0)
        self.assertEqual(glow[3], 255)
        scene = example()["scenes"][0]
        canvas_bg = dark_overlay(scene, canvas=canvas, font_path=TITLE_FONT, stage=0)
        vx, vy, vw, vh = video_box(canvas)
        center = canvas_bg.getpixel((vx+vw//4, vy+vh//2))
        self.assertEqual(center[3], 255)
        self.assertTrue(max(center[:3]) - min(center[:3]) <= 7, "panel must be neutral black, not bluish graphite")
        # Existing scene composition and Line MD remain valid under Black Dark.
        self.assertNotEqual(canvas_bg.tobytes(), dark_overlay(scene, canvas=canvas, font_path=TITLE_FONT, stage=-1).tobytes())

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


    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe missing")
    def test_ffmpeg_smoke_renders_real_mp4_with_local_animated_assets(self):
        """Ensure actual FFmpeg ingestion and overlay, not only PNG mock previews."""
        from processor.editorial_renderer import _encode_silent_scene
        from processor.lower_third import LowerThird
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            source=root/"source.mp4"
            subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y",
                            "-f","lavfi","-i","testsrc=size=640x360:rate=15",
                            "-t","3","-c:v","libx264","-pix_fmt","yuv420p",str(source)],
                           check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            font=Path(TITLE_FONT)
            ass=root/"empty.ass"
            ass.write_text("[Script Info]\nScriptType: v4.00+\nPlayResX: 360\nPlayResY: 640\n"
                           "[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n"
                           "Style: Clean,Arial,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,20,20,50,1\n"
                           "[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n",encoding="utf-8")
            scene={**example()["scenes"][0],"_visual_style":"motion_dark",
                   "_paper_words":[],"_credit":"Fonte: Entrevista"}
            scene["background"]={"start":0,"end":2}
            canvas=Canvas.for_format(width=360,fps=15)
            (root/"scene").mkdir()
            (root/"shared").mkdir()
            out=root/"rendered.mp4"
            _encode_silent_scene(source,scene,root/"scene",out,canvas=canvas,
                                 treatment=LowerThird(),ass=ass,font_path=font,
                                 duration=1.5,ffmpeg="ffmpeg",shared_dir=root/"shared",
                                 source_hash=hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertTrue(out.is_file())
            self.assertGreater(out.stat().st_size,10000)
            result=subprocess.check_output(["ffprobe","-v","error","-select_streams","v:0",
                    "-show_entries","stream=width,height","-of","csv=p=0",str(out)],text=True).strip()
            self.assertEqual(result,"360,640")


if __name__=="__main__":
    unittest.main()
