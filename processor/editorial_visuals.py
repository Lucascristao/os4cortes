"""Reusable moving editorial backgrounds and transparent, staged text overlays.

No remote assets, fonts or processes are discovered. Callers supply a font or
use an installed Arial/DejaVu Sans fallback. Source audio is never retained by
``render_background``; the compositor owns narration and caption timing.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import shutil
import subprocess
from typing import Sequence

from PIL import Image, ImageDraw, ImageFont

from .lower_third import LowerThird
from .branding import CHANNEL_BADGE, normalize_branding

VISUAL_STYLE_VERSION = "os4-creator-black-motion-2026-v4-fitted-safe-text"
BACKGROUND_STYLE_VERSION = "os4-creator-black-motion-2026-v1"


def _number(value: float, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number.")
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}.")
    return float(value)


@dataclass(frozen=True)
class Canvas:
    width: int = 1080
    height: int = 1920
    fps: int = 30

    def __post_init__(self) -> None:
        for name in ("width", "height", "fps"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer.")
        if self.width % 2 or self.height % 2:
            raise ValueError("Canvas dimensions must be even for yuv420p.")

    @classmethod
    def for_format(cls, aspect: str = "9:16", width: int | None = None,
                   fps: int = 30) -> Canvas:
        if aspect not in ("9:16", "16:9"):
            raise ValueError("Supported formats are 9:16 and 16:9.")
        width = width if width is not None else (1080 if aspect == "9:16" else 1920)
        if isinstance(width, bool) or not isinstance(width, int) or width <= 0 or width % 2:
            raise ValueError("width must be a positive even integer.")
        numerator, denominator = map(int, aspect.split(":"))
        height = 2 * round(width * denominator / numerator / 2)
        return cls(width, height, fps)

    @property
    def portrait(self) -> bool:
        return self.height > self.width

    def safe_zones(self) -> dict[str, tuple[int, int, int, int]]:
        """Pixel bounds (left, top, right, bottom), leaving captions unobstructed."""
        w, h = self.width, self.height
        if self.portrait:
            return {
                "content": (round(.074*w), round(.16*h), round(.91*w), round(.65*h)),
                "captions": (round(.074*w), round(.70*h), round(.91*w), round(.86*h)),
                "credit": (round(.074*w), round(.93*h), round(.91*w), round(.97*h)),
            }
        return {
            "content": (round(.065*w), round(.14*h), round(.90*w), round(.66*h)),
            "captions": (round(.065*w), round(.75*h), round(.90*w), round(.89*h)),
            "credit": (round(.065*w), round(.93*h), round(.90*w), round(.97*h)),
        }


@dataclass(frozen=True)
class EditorialScene:
    title: str
    kicker: str = ""
    lines: tuple[str, ...] = ()
    credit: str = ""
    brand: str = CHANNEL_BADGE

    def __post_init__(self) -> None:
        for name in ("title", "kicker", "credit", "brand"):
            if not isinstance(getattr(self, name), str):
                raise ValueError(f"{name} must be text.")
        if not self.title.strip():
            raise ValueError("A scene title is required.")
        if isinstance(self.lines, str) or not isinstance(self.lines, Sequence):
            raise ValueError("lines must be a sequence of short text items.")
        if len(self.lines) > 3 or any(not isinstance(line, str) or not line.strip()
                                      for line in self.lines):
            raise ValueError("Use at most three nonempty overlay lines.")
        object.__setattr__(self, "lines", tuple(self.lines))
        object.__setattr__(self, "brand", normalize_branding(self.brand))


def build_background_filter(
    canvas: Canvas = Canvas(), *, lower_third: LowerThird | None = None,
    blur_sigma: float | None = None, darkness: float = .68,
    focus_x: float = .54, focus_y: float = .45,
    subtle_motion: bool = False, duration: float = 8.0,
) -> str:
    """FFmpeg filter chain; lower-third removal happens in source coordinates.

    ``focus_x``/``focus_y`` select a normalized focal point after source banner
    removal. Blur defaults to 0.65% of the output's short dimension, so a face
    remains recognizable. Saturation is always zero and the default black
    layer is 68%, preventing a colored cast from the source footage.
    Subtle motion is useful for still images; moving
    footage normally supplies its own motion and does not need it.
    """
    darkness = _number(darkness, "darkness", 0, .85)
    focus_x = _number(focus_x, "focus_x", 0, 1)
    focus_y = _number(focus_y, "focus_y", 0, 1)
    duration = _number(duration, "duration", .05, 86400)
    sigma = min(canvas.width, canvas.height) * .0065 if blur_sigma is None else blur_sigma
    sigma = _number(sigma, "blur_sigma", 0, 100)
    treatment = lower_third or LowerThird()
    filters = []
    if treatment.mode == "crop":
        fraction = treatment.height_fraction
        filters.append(f"crop=iw:ih-ceil(ih*{fraction:.9f}):0:0")
    elif treatment.mode == "cover":
        fraction = treatment.height_fraction
        filters.append(f"drawbox=x=0:y=ih-ceil(ih*{fraction:.9f}):w=iw:h=ceil(ih*{fraction:.9f}):color=black:t=fill")
    filters.extend([
        f"scale={canvas.width}:{canvas.height}:force_original_aspect_ratio=increase",
        f"crop={canvas.width}:{canvas.height}:"
        f"'max(0,min(iw-ow,iw*{focus_x:.6f}-ow/2))':"
        f"'max(0,min(ih-oh,ih*{focus_y:.6f}-oh/2))'",
        "setsar=1", "setpts=PTS-STARTPTS",
    ])
    if subtle_motion:
        frames = max(1, round(duration*canvas.fps)-1)
        filters.append(
            f"zoompan=z='1+0.012*min(on/{frames},1)':"
            f"x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:"
            f"s={canvas.width}x{canvas.height}:fps={canvas.fps}")
    if sigma:
        filters.append(f"gblur=sigma={sigma:.4f}:steps=2")
    filters.append("hue=s=0")
    if darkness:
        filters.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=black@{darkness:.5f}:t=fill")
    filters.extend([f"fps={canvas.fps}", "format=yuv420p"])
    return ",".join(filters)


def render_background(
    source: str | Path, output: str | Path, *, start: float = 0,
    duration: float = 8, canvas: Canvas = Canvas(), is_image: bool = False,
    ffmpeg: str | Path = "ffmpeg", lower_third: LowerThird | None = None,
    blur_sigma: float | None = None, darkness: float = .68,
    focus_x: float = .54, focus_y: float = .45,
    subtle_motion: bool | None = None,
) -> Path:
    """Render a silent moving background from a video interval or a still image."""
    start = _number(start, "start", 0, 86400*365)
    duration = _number(duration, "duration", .05, 86400)
    source, output = Path(source), Path(output)
    if not source.is_file():
        raise FileNotFoundError(source)
    if source.resolve() == output.resolve():
        raise ValueError("Background output must differ from its source.")
    output.parent.mkdir(parents=True, exist_ok=True)
    executable = shutil.which(str(ffmpeg)) or (str(ffmpeg) if Path(ffmpeg).is_file() else None)
    if executable is None:
        raise FileNotFoundError(f"FFmpeg is unavailable: {ffmpeg}")
    filters = build_background_filter(
        canvas, lower_third=lower_third, blur_sigma=blur_sigma,
        darkness=darkness, focus_x=focus_x, focus_y=focus_y,
        subtle_motion=is_image if subtle_motion is None else subtle_motion,
        duration=duration)
    inputs = ["-loop", "1", "-framerate", str(canvas.fps)] if is_image else ["-ss", str(start)]
    subprocess.run([
        executable, "-hide_banner", "-loglevel", "error", "-y", *inputs,
        "-i", str(source), "-t", f"{duration:.6f}", "-an", "-vf", filters,
        "-frames:v", str(max(1, round(duration*canvas.fps))),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
    ], check=True)
    return output


def _font(path: str | Path | None, size: int):
    if path is not None:
        return ImageFont.truetype(str(path), size)
    for name in ("arialbd.ttf", "DejaVuSans-Bold.ttf", "Arial.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    raise FileNotFoundError("Supply a local TrueType font_path for editorial overlays.")


def _wrap(draw, value: str, font, width: int) -> str:
    lines = []
    for paragraph in value.split("\n"):
        line = ""
        for word in paragraph.split():
            candidate = f"{line} {word}".strip()
            if line and draw.textlength(candidate, font=font) > width:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
    return "\n".join(lines)


def layout_overlay(
    scene: EditorialScene, *, canvas: Canvas = Canvas(),
    font_path: str | Path | None = None, body_font_path: str | Path | None = None,
) -> dict:
    """Measure every staged text item before media or paid narration work.

    Bounds describe actual ink, rather than Pillow's font-origin bearing. The
    support items replace one another, so each may use the free space below
    the title. Fit font size and interline spacing without deleting any text.
    Coordinates are supersampled, matching the final PNG renderer exactly.
    """
    scale = 2
    w, h = canvas.width*scale, canvas.height*scale
    draw = ImageDraw.Draw(Image.new("L", (1, 1)))
    zones = canvas.safe_zones()
    left, top, right, bottom = (value*scale for value in zones["content"])
    short = min(w, h)
    title_size = round(short*(.126 if canvas.portrait else .118))
    body_size = round(short*(.043 if canvas.portrait else .040))
    small_size = round(short*.023)
    padding = round(short*.009)
    text_left = left + padding
    # Include the emphasis strip and shadow in the safe horizontal bounds.
    text_width = min(right-text_left-padding-scale,
                     right-left-24*scale if canvas.portrait else round(w*.64))
    spacing = round(short*.006)
    blocks = []

    def block(kind, value, font, x, y, *, gap=spacing, fill=(247, 247, 247, 255),
              shadow=True, highlight=False, index=None):
        box = draw.multiline_textbbox((0, 0), value, font=font, spacing=gap)
        # y is the actual ink top. A positive ascender bearing is not extra
        # content height and must not cause a false overflow.
        origin = (x-box[0], y-box[1])
        bounds = (x, y, x+box[2]-box[0], y+box[3]-box[1])
        return {"kind": kind, "index": index, "text": value, "font": font,
                "font_size": font.size, "xy": origin, "bounds": bounds,
                "spacing": gap, "fill": fill, "shadow": shadow, "highlight": highlight}

    def fit_text(value, field, *, maximum, minimum, x, y, width, floor,
                 max_lines=None, movable=False, fill=(247, 247, 247, 255)):
        for size in range(maximum, minimum-1, -1):
            font = _font(body_font_path or font_path, size)
            wrapped = _wrap(draw, value, font, width)
            if max_lines is not None and len(wrapped.splitlines()) > max_lines:
                continue
            for gap in range(spacing, max(1, round(short*.002))-1, -1):
                measured = block(field, wrapped, font, x, y, gap=gap, fill=fill)
                bounds = measured["bounds"]
                ink_height = bounds[3]-bounds[1]
                actual_top = min(y, floor-scale-ink_height) if movable else y
                if (bounds[2] <= x+width and actual_top >= top
                        and (not movable or actual_top >= title_bottom+round(short*.03))
                        and actual_top+ink_height+scale <= floor):
                    return block(field, wrapped, font, x, actual_top, gap=gap, fill=fill)
        raise ValueError(f"{field}: texto não cabe na área segura com fonte legível; revise este campo.")

    brand_y = round(h*(.055 if canvas.portrait else .066))
    blocks.append(block("brand", scene.brand, _font(font_path, round(short*.023)), left, brand_y))
    kicker_bottom = top
    if scene.kicker:
        kicker = fit_text(scene.kicker.upper(), "visual.kicker", maximum=small_size,
                          minimum=round(short*.018), x=text_left, y=top, width=text_width,
                          floor=round(h*.225), max_lines=2, fill=(255, 201, 40, 255))
        blocks.append(kicker)
        kicker_bottom = kicker["bounds"][3]
    title_y = max(round(h*(.232 if canvas.portrait else .235)),
                  kicker_bottom+round(short*.025))
    max_title_height = round(h*(.27 if canvas.portrait else .30))
    title_font, title_lines, line_advance = None, [], 0
    for size in range(title_size, round(title_size*.48)-1, -2):
        candidate_font = _font(font_path, size)
        candidate = _wrap(draw, scene.title.upper(), candidate_font, text_width).splitlines()
        if len(candidate) > 1 and any(line.strip("?!.,:") in {"A", "O", "AS", "OS", "E", "É", "DE", "DO", "DA", "UM", "UMA"} for line in candidate):
            continue
        advance = round(size*.94)
        raw_boxes = [draw.textbbox((0, 0), line, font=candidate_font) for line in candidate]
        for index in range(len(raw_boxes)-1):
            emphasis_padding = round(short*.009) if index == len(raw_boxes)-2 else 0
            advance = max(advance, raw_boxes[index][3]-raw_boxes[index+1][1]+emphasis_padding+round(short*.004))
        boxes = [draw.textbbox((0, index*advance), line, font=candidate_font)
                 for index, line in enumerate(candidate)]
        if (max(box[2]-box[0] for box in boxes) <= text_width
                and boxes[-1][3]-boxes[0][1]+2*padding <= max_title_height
                and title_y+boxes[-1][3]-boxes[0][1]+padding < bottom):
            title_font, title_lines, line_advance = candidate_font, candidate, advance
            break
    if title_font is None:
        raise ValueError("visual.title: título não cabe na área segura com fonte legível; revise este campo.")
    first_top = draw.textbbox((0, 0), title_lines[0], font=title_font)[1]
    for index, line in enumerate(title_lines):
        ink_top = title_y+index*line_advance+draw.textbbox((0, 0), line, font=title_font)[1]-first_top
        emphasis = index == len(title_lines)-1
        blocks.append(block("title", line, title_font, text_left, ink_top,
                            fill=(8, 8, 8, 255) if emphasis else (247, 247, 247, 255),
                            shadow=not emphasis, highlight=emphasis))
    title_bottom = blocks[-1]["bounds"][3]+padding
    for index, line in enumerate(scene.lines):
        item = fit_text(line, f"visual.lines[{index}]", maximum=body_size,
                        minimum=round(short*.030), x=text_left,
                        y=round(h*(.590 if canvas.portrait else .575)), width=text_width,
                        floor=bottom, movable=True, fill=(229, 229, 229, 255))
        item.update(kind="body", index=index)
        blocks.append(item)

    if scene.credit:
        credit_left, credit_top, credit_right, credit_bottom = (value*scale for value in zones["credit"])
        # Credit has its own zone, so pass its ink top through the same fitter.
        credit = fit_text(scene.credit, "credit", maximum=round(short*.019),
                          minimum=round(short*.014), x=credit_left, y=credit_top,
                          width=credit_right-credit_left-scale, floor=credit_bottom,
                          fill=(180, 180, 180, 220))
        blocks.append(credit)
    return {"scale": scale, "size": (w, h), "blocks": blocks, "padding": padding}


def render_overlay_png(
    scene: EditorialScene, output: str | Path, *, canvas: Canvas = Canvas(),
    stage: int | None = None, font_path: str | Path | None = None,
    body_font_path: str | Path | None = None,
) -> Path:
    """Render the measured creator overlay; support items replace one another."""
    if stage is not None and (isinstance(stage, bool) or not isinstance(stage, int) or stage < 0):
        raise ValueError("stage must be a nonnegative integer or None.")
    layout = layout_overlay(scene, canvas=canvas, font_path=font_path, body_font_path=body_font_path)
    image = Image.new("RGBA", layout["size"], (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    scale, padding = layout["scale"], layout["padding"]
    selected_line = len(scene.lines)-1 if stage is None else min(len(scene.lines)-1, stage-2)
    for item in layout["blocks"]:
        if item["kind"] == "title" and stage is not None and stage < 1:
            continue
        if item["kind"] == "body" and ((stage is not None and stage < 2) or item["index"] != selected_line):
            continue
        x, y = item["xy"]
        if item["highlight"]:
            box = item["bounds"]
            draw.rectangle((box[0]-padding, box[1]-padding, box[2]+padding, box[3]+padding), fill="#ffc928")
        if item["shadow"]:
            draw.multiline_text((x+scale, y+scale), item["text"], font=item["font"],
                                fill=(0, 0, 0, 110), spacing=item["spacing"])
        draw.multiline_text((x, y), item["text"], font=item["font"], fill=item["fill"], spacing=item["spacing"])

    image = image.resize((canvas.width, canvas.height), Image.Resampling.LANCZOS)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, optimize=True)
    return output


def overlay_timeline(scene: EditorialScene, duration: float) -> list[dict[str, float | int]]:
    """Spread support changes over narration; the compositor owns entry easing.

    With two support lines they appear at 27% and 64% of the real WAV length.
    Titles and branding hold steady while support lines replace one another.
    """
    duration = _number(duration, "duration", .05, 86400)
    starts = [0.0, min(.32, duration*.06)]
    count = len(scene.lines)
    fractions = {0: (), 1: (.35,), 2: (.27, .64), 3: (.24, .49, .74)}[count]
    starts.extend(duration*fraction for fraction in fractions)
    return [{"stage": stage, "start": start,
             "end": starts[stage+1] if stage+1 < len(starts) else duration}
            for stage, start in enumerate(starts)]
