"""Reproducible source-media visual proof for all six native cover presets.

Run locally against authorized source media; only reduced approved references,
fonts and geometry are versioned. Generated QA media stays in ignored output/.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

from .covers import TEMPLATE_IDS, _font, render_cover
from .lower_third import LowerThird


def _sheet(images, output, *, portrait=False, square=False, small=False):
    width, height = (320, 180) if small else (270, 270 if square else 480) if portrait else (640, 360)
    columns, gap, pad = (3 if portrait else 2), 20, 30
    rows = (len(images)+columns-1)//columns
    canvas = Image.new("RGB", (pad*2+width*columns+gap*(columns-1),
                                85+rows*(height+45)+pad), "#101217")
    draw = ImageDraw.Draw(canvas)
    label = "Vertical / recorte central 1:1" if square else "YouTube / 320 x 180" if small else "9:16 / rostos reais" if portrait else "16:9 / rostos reais"
    draw.text((pad, 25), label, font=_font(25), fill="#f7f7f4")
    for index, (identifier, path) in enumerate(images):
        with Image.open(path) as original:
            image = original.convert("RGB")
        if square:
            top = (image.height-image.width)//2
            image = image.crop((0, top, image.width, top+image.width))
        x, y = pad+(index % columns)*(width+gap), 85+(index//columns)*(height+45)
        canvas.paste(image.resize((width, height), Image.Resampling.LANCZOS), (x, y))
        draw.text((x, y+height+10), identifier, font=_font(17, credit=True), fill="#dce0e5")
    canvas.save(output, quality=94, subsampling=0)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--range", action="append", required=True, dest="ranges", metavar="START:END")
    parser.add_argument("--output", type=Path, default=Path("output/cover-production-qa"))
    parser.add_argument("--title", default="O QUE ROBERTA CONFIRMA?")
    parser.add_argument("--source-label", default="")
    parser.add_argument("--lower-third-mode", choices=("off", "crop", "cover"), default="off")
    parser.add_argument("--lower-third-height", type=float, default=0)
    parser.add_argument("--work-dir", type=Path, default=Path(".render_work/cover-qa"))
    args = parser.parse_args(argv)
    intervals = [tuple(map(float, item.split(":"))) for item in args.ranges]
    args.output.mkdir(parents=True, exist_ok=True)
    reports = []
    for aspect in ("9:16", "16:9"):
        images = []
        for identifier in TEMPLATE_IDS:
            target = args.output/aspect.replace(":", "x")/f"{identifier}.jpg"
            report = render_cover(args.source, intervals, target,
                                  cover={"version": 1, "template_id": identifier, "title": args.title},
                                  title=args.title, aspect=aspect,
                                  lower_third=LowerThird(args.lower_third_mode, args.lower_third_height),
                                  work_dir=args.work_dir, source_label=args.source_label)
            reports.append(report)
            images.append((identifier, target))
        portrait = aspect == "9:16"
        _sheet(images, args.output/f"matrix-{aspect.replace(':', 'x')}.jpg", portrait=portrait)
        _sheet(images, args.output/("center-square.jpg" if portrait else "youtube-320.jpg"),
               portrait=portrait, square=portrait, small=not portrait)
    (args.output/"manifest.json").write_text(json.dumps({"reports": reports}, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output.resolve()), "covers": len(reports),
                      "applied": [report["applied_template"] for report in reports]}))


if __name__ == "__main__":
    main()
