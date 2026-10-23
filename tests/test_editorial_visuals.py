"""Offline typography gates: complete text, safe bounds, and no paid work."""
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw

from processor.covers import TITLE_FONT
from processor.editorial_visuals import Canvas, EditorialScene, layout_overlay, render_overlay_png


class EditorialVisualsTests(unittest.TestCase):
    def test_long_support_text_fits_both_aspects_without_losing_words(self):
        line = ("O cidadão pode cobrar resultados, comparar propostas e acompanhar o uso dos impostos "
                "sem depender de promessas feitas durante a eleição.")
        scene = EditorialScene(title="QUEM PAGA ESSA CONTA?", kicker="ECONOMIA E POLÍTICA",
                               lines=(line, "Uma segunda ideia aparece depois, sem acumular textos na tela."),
                               credit="Fonte: TICARACATICAST | 2026-10-22")
        for aspect in ("9:16", "16:9"):
            with self.subTest(aspect=aspect):
                canvas = Canvas.for_format(aspect)
                layout = layout_overlay(scene, canvas=canvas, font_path=TITLE_FONT)
                left, top, right, bottom = (n*layout["scale"] for n in canvas.safe_zones()["content"])
                bodies = [item for item in layout["blocks"] if item["kind"] == "body"]
                title_bottom = max(item["bounds"][3]+layout["padding"]
                                   for item in layout["blocks"] if item["kind"] == "title")
                self.assertEqual(len(bodies), len(scene.lines))
                draw = ImageDraw.Draw(Image.new("L", (1, 1)))
                for original, item in zip(scene.lines, bodies):
                    self.assertEqual(item["text"].split(), original.split())
                    self.assertGreaterEqual(item["font_size"]/layout["scale"], 32)
                    bounds = draw.multiline_textbbox(item["xy"], item["text"], font=item["font"], spacing=item["spacing"])
                    self.assertEqual(bounds, item["bounds"])
                    self.assertGreaterEqual(bounds[0], left)
                    self.assertGreaterEqual(bounds[1], title_bottom)
                    self.assertLessEqual(bounds[2]+layout["scale"], right)
                    self.assertLessEqual(bounds[3]+layout["scale"], bottom)
                # The previous fixed anchor rejected this text, although space
                # between the title and support region was still unused.
                self.assertLess(bodies[0]["bounds"][1], round(canvas.height*2*(.590 if canvas.portrait else .575)))
                for item in layout["blocks"]:
                    if item["kind"] == "title" and item["highlight"]:
                        self.assertGreaterEqual(item["bounds"][0]-layout["padding"], left)
                        self.assertLessEqual(item["bounds"][2]+layout["padding"], right)

    def test_all_support_stages_are_validated_even_when_last_one_is_short(self):
        scene = EditorialScene(title="UMA PERGUNTA", lines=("W"*140, "Resposta curta."))
        for aspect in ("9:16", "16:9"):
            with self.subTest(aspect=aspect), self.assertRaisesRegex(ValueError, r"visual\.lines\[0\].*fonte legível"):
                layout_overlay(scene, canvas=Canvas.for_format(aspect), font_path=TITLE_FONT)

    def test_dense_title_and_support_shrink_font_above_readable_floor(self):
        scene = EditorialScene(title=("REGRA "*17)[:100], lines=(("IMPOSTOS "*16)[:140],))
        canvas = Canvas.for_format("16:9")
        layout = layout_overlay(scene, canvas=canvas, font_path=TITLE_FONT)
        body = next(item for item in layout["blocks"] if item["kind"] == "body")
        self.assertLess(body["font_size"], round(min(layout["size"])*.040))
        self.assertGreaterEqual(body["font_size"], round(min(layout["size"])*.030))
        self.assertEqual(body["text"].split(), scene.lines[0].split())

    def test_rendered_stages_keep_branding_identical_and_support_separate(self):
        scene = EditorialScene(title="UMA PERGUNTA", lines=("Primeira resposta.", "Segunda resposta."))
        canvas = Canvas.for_format("9:16", width=540)
        with tempfile.TemporaryDirectory() as folder:
            paths = [render_overlay_png(scene, Path(folder)/f"stage-{stage}.png", canvas=canvas,
                                        stage=stage, font_path=TITLE_FONT) for stage in (0, 2, 3)]
            images = [Image.open(path).convert("RGBA") for path in paths]
            try:
                brand_box = (0, 0, canvas.width, round(canvas.height*.13))
                self.assertEqual(images[0].crop(brand_box).tobytes(), images[1].crop(brand_box).tobytes())
                self.assertEqual(images[1].crop(brand_box).tobytes(), images[2].crop(brand_box).tobytes())
                self.assertNotEqual(images[1].tobytes(), images[2].tobytes())
            finally:
                for image in images:
                    image.close()


if __name__ == "__main__":
    unittest.main()
