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

VISUAL_STYLE_VERSION = "os4-creator-black-motion-2026-v1"


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
    brand: str = "OS4 CORTES"

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


def render_overlay_png(
    scene: EditorialScene, output: str | Path, *, canvas: Canvas = Canvas(),
    stage: int | None = None, font_path: str | Path | None = None,
    body_font_path: str | Path | None = None,
) -> Path:
    """Creator typography on a transparent canvas; no news or slide furniture.

    stage 0: compact brand/kicker/credit; 1: oversized title with an amber
    emphasis line; 2: title plus first support line; 3: title plus second
    support line, REPLACING the first. Later stages follow the same rule.
    None previews the final stage. Persistent elements are pixel-identical
    between stages so a compositor can animate only the changed region.
    """
    if stage is not None and (isinstance(stage, bool) or not isinstance(stage, int) or stage < 0):
        raise ValueError("stage must be a nonnegative integer or None.")
    scale = 2
    w, h = canvas.width*scale, canvas.height*scale
    image = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    zones = canvas.safe_zones()
    left, top, right, bottom = (value*scale for value in zones["content"])
    short = min(w, h)
    title_size = round(short*(.126 if canvas.portrait else .118))
    body_size = round(short*(.043 if canvas.portrait else .040))
    small_size = round(short*.023)
    text_width = right-left-24*scale if canvas.portrait else round(w*.64)

    def paint(xy, value, font, fill=(247, 247, 247, 255), spacing=None, shadow=True):
        spacing = round(short*.006) if spacing is None else spacing
        if shadow:
            draw.multiline_text((xy[0]+scale, xy[1]+scale), value, font=font,
                                fill=(0, 0, 0, 110), spacing=spacing)
        draw.multiline_text(xy, value, font=font, fill=fill, spacing=spacing)

    brand_y = round(h*(.055 if canvas.portrait else .066))
    paint((left, brand_y), scene.brand, _font(font_path, round(short*.023)))
    kicker_font = _font(body_font_path or font_path, small_size)
    if scene.kicker:
        kicker = _wrap(draw, scene.kicker.upper(), kicker_font, text_width)
        if len(kicker.splitlines()) > 2:
            raise ValueError("The kicker is too long for the overlay safe zone.")
        paint((left, top), kicker, kicker_font, (255, 201, 40, 255))
    title_y = round(h*(.232 if canvas.portrait else .235))
    max_title_height = round(h*(.27 if canvas.portrait else .30))
    title_font, title_lines, line_advance = None, [], 0
    for size in range(title_size, round(title_size*.48), -2):
        candidate_font = _font(font_path, size)
        candidate = _wrap(draw, scene.title.upper(), candidate_font, text_width).splitlines()
        advance = round(size*.94)
        boxes = [draw.textbbox((0, index*advance), line, font=candidate_font)
                 for index, line in enumerate(candidate)]
        if max(box[2] for box in boxes) <= text_width and boxes[-1][3]-boxes[0][1] <= max_title_height:
            title_font, title_lines, line_advance = candidate_font, candidate, advance
            break
    if title_font is None:
        raise ValueError("The title is too long to remain readable in the overlay safe zone.")
    if stage is None or stage >= 1:
        first_top = draw.textbbox((0, 0), title_lines[0], font=title_font)[1]
        origin = title_y-first_top
        for index, line in enumerate(title_lines):
            xy = (left, origin+index*line_advance)
            if index == len(title_lines)-1:
                # A fitted emphasis strip, not an opaque card over the source.
                box = draw.textbbox(xy, line, font=title_font)
                px, py = round(short*.009), round(short*.009)
                draw.rectangle((box[0]-px, box[1]-py, box[2]+px, box[3]+py), fill="#ffc928")
                paint(xy, line, title_font, (8, 8, 8, 255), shadow=False)
            else:
                paint(xy, line, title_font)

    body_y = round(h*(.590 if canvas.portrait else .575))
    body_font = _font(body_font_path or font_path, body_size)
    selected_line = len(scene.lines)-1 if stage is None else min(len(scene.lines)-1, stage-2)
    for index, line in enumerate(scene.lines):
        wrapped = _wrap(draw, line, body_font, text_width)
        bounds = draw.multiline_textbbox((left, body_y), wrapped, font=body_font,
                                         spacing=round(short*.006))
        if bounds[3] > bottom or bounds[2] > right:
            raise ValueError("Overlay lines overflow the content zone; shorten the scene text.")
        if (stage is None or stage >= 2) and index == selected_line:
            paint((left, body_y), wrapped, body_font, (229, 229, 229, 255))

    if scene.credit:
        credit_left, credit_top, credit_right, credit_bottom = (value*scale for value in zones["credit"])
        credit_font = _font(body_font_path or font_path, round(short*.019))
        wrapped = _wrap(draw, scene.credit, credit_font, credit_right-credit_left)
        bounds = draw.multiline_textbbox((credit_left, credit_top), wrapped, font=credit_font,
                                         spacing=round(short*.005))
        if bounds[3] > credit_bottom:
            raise ValueError("Credit is too long for the credit safe zone.")
        paint((credit_left, credit_top), wrapped, credit_font, (180, 180, 180, 220),
              spacing=round(short*.005))

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
