"""Automatic OS4 Motion Dark compositing. Python/Pillow + FFmpeg; no paid media calls.

Multi-beat temporal timeline graphics with narrative synchronization:
- Black Dark aesthetic: true #000000 background, localized amber lights, #090909-#161616 surfaces.
- Dynamic components: metrics, kinetic headlines, comparisons, strike-through lists, document cards.
- Flexible source video staging (window, bottom, hidden) driven by narrative needs.
- Stroke-dashoffset SVG sampling from vendored Line MD assets with robust Pillow fallback.
"""
from __future__ import annotations

from functools import lru_cache
from io import BytesIO
from pathlib import Path
import math
import re
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from .editorial_paper import paper_timeline, video_box, _fit, _wrap
from .branding import CHANNEL_BADGE, CHANNEL_HANDLE
from .editorial_timeline import resolve_scene_timeline, MotionBeat

MOTION_DARK_STYLE_VERSION = "os4-motion-dark-v3-cinematic-beats"
ASSETS = Path(__file__).resolve().parent / "assets" / "line_md"
ICON_NAMES = ("confirm-circle", "alert-circle", "chat", "clipboard-check")
LAYOUT_NAMES = ("source_card", "statement", "comparison", "quote", "number")

GOLD = (202, 163, 88, 255)
GOLD_FAINT = (202, 163, 88, 70)
BLACK = (0, 0, 0, 255)
SURFACE = (12, 12, 12, 255)
SURFACE_RAISED = (20, 18, 16, 255)
WHITE = (249, 247, 241, 255)
MUTED = (172, 172, 172, 255)
RED_ACCENT = (215, 65, 50, 255)
NS = "{http://www.w3.org/2000/svg}"


def icon_name(value: str) -> str:
    name = str(value).removeprefix("line-md:")
    if name not in ICON_NAMES:
        raise ValueError(f"Icon not in the local Line MD catalogue: {value}")
    return name


def _seconds(value: str) -> float:
    return float(str(value or "0").rstrip("s"))


def _pillow_icon_fallback(name: str, pixel_size: int, frame: int) -> Image.Image:
    """Deterministic Pillow-only vector icon animation when CairoSVG is unavailable."""
    img = Image.new("RGBA", (pixel_size, pixel_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    stroke = max(2, round(pixel_size * 0.07))
    pad = round(pixel_size * 0.14)
    progress = min(1.0, max(0.0, frame / 30.0))
    box = (pad, pad, pixel_size - pad, pixel_size - pad)

    if progress > 0.02:
        end_angle = -90 + int(360 * progress)
        draw.arc(box, start=-90, end=end_angle, fill=GOLD, width=stroke)

    if progress > 0.35:
        p2 = (progress - 0.35) / 0.65
        cx, cy = pixel_size // 2, pixel_size // 2
        r = (pixel_size - pad * 2) // 4
        if name in ("confirm-circle", "clipboard-check"):
            x1, y1 = cx - r, cy
            x2, y2 = cx - r // 3, cy + r
            x3, y3 = cx + r, cy - r
            draw.line([(x1, y1), (x2, y2)], fill=GOLD, width=stroke)
            if p2 > 0.4:
                draw.line([(x2, y2), (x3, y3)], fill=GOLD, width=stroke)
        elif name == "alert-circle":
            draw.line([(cx, cy - r), (cx, cy + r // 3)], fill=GOLD, width=stroke)
            draw.ellipse((cx - stroke // 2, cy + r - stroke, cx + stroke // 2, cy + r), fill=GOLD)
        elif name == "chat":
            draw.line([(cx - r, cy), (cx + r, cy)], fill=GOLD, width=stroke)
            if p2 > 0.5:
                draw.line([(cx - r, cy + stroke * 2), (cx + r // 2, cy + stroke * 2)], fill=GOLD, width=stroke)
    return img


@lru_cache(maxsize=120)
def _icon_frame(name: str, pixel_size: int, frame: int) -> Image.Image:
    """Sample the actual stroke-dashoffset keyframes from the shipped SVG."""
    name = icon_name(name)
    try:
        import cairosvg  # type: ignore
        svg_file = ASSETS / (name + ".svg")
        root = ET.fromstring(svg_file.read_text(encoding="utf-8").replace("currentColor", "#CAA358"))
        t = max(0, frame) / 30.0
        for parent in root.iter():
            for child in list(parent):
                if child.tag != NS + "animate":
                    continue
                if child.get("attributeName") == "stroke-dashoffset":
                    values = child.get("values")
                    start = float(values.split(";")[0]) if values else float(parent.get("stroke-dashoffset", "0"))
                    stop = float(values.split(";")[-1]) if values else float(child.get("to", "0"))
                    begin = _seconds(child.get("begin", "0"))
                    dur = max(0.001, _seconds(child.get("dur", ".1")))
                    amount = min(1.0, max(0.0, (t - begin) / dur))
                    parent.set("stroke-dashoffset", f"{start + (stop - start) * amount:.4f}")
                parent.remove(child)
        data = cairosvg.svg2png(bytestring=ET.tostring(root), output_width=pixel_size, output_height=pixel_size)
        return Image.open(BytesIO(data)).convert("RGBA")
    except (ImportError, OSError, ValueError):
        return _pillow_icon_fallback(name, pixel_size, frame)


@lru_cache(maxsize=8)
def _background(width: int, height: int) -> Image.Image:
    """True black canvas; only two tightly focused practical lights touch it."""
    base = Image.new("RGBA", (width, height), BLACK)
    lights = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(lights, "RGBA")
    draw.ellipse((int(width * 0.03), int(height * 0.15), int(width * 0.53), int(height * 0.38)), fill=(188, 124, 50, 54))
    draw.ellipse((int(width * 0.68), int(height * 0.62), int(width * 0.92), int(height * 0.76)), fill=(153, 118, 74, 24))
    return Image.alpha_composite(base, lights.filter(ImageFilter.GaussianBlur(max(6, round(width * 0.065)))))


def _panel_backlight(image: Image.Image, window, *, canvas) -> Image.Image:
    """Soft amber edge glow makes a black layer dimensional without greying the frame."""
    vx, vy, vw, vh = window
    w, h = canvas.width, canvas.height
    radius = max(8, round(min(w, h) * 0.027))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle(
        (vx - 2, vy - 2, vx + vw + 1, vy + vh + 1),
        radius=radius + 2,
        outline=(194, 134, 60, 95),
        width=max(3, round(w * 0.012)),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(max(7, round(w * 0.033))))
    return Image.alpha_composite(image, glow)


def _multiline(draw, item, fill, dy=0):
    if not item:
        return
    xy = item["xy"]
    draw.multiline_text((xy[0], xy[1] + dy), item["text"], font=item["font"], spacing=item["spacing"], fill=fill)


def _highlight_title(image, item, emphasis: str, yshift=0):
    """Tint the selected literal title phrase; no filled subtitle rectangles."""
    if not item or not emphasis:
        return
    words = emphasis.strip().split()
    if len(words) > 4:
        return
    draw = ImageDraw.Draw(image)
    for lineno, line in enumerate(item["text"].split("\n")):
        hit = re.search(re.escape(emphasis.strip()), line, re.IGNORECASE)
        if not hit:
            continue
        font = item["font"]
        width_before = draw.textlength(line[: hit.start()], font=font)
        line_height = font.size + item["spacing"]
        xy = (item["xy"][0] + width_before, item["xy"][1] + lineno * line_height + yshift)
        draw.text(xy, line[hit.start() : hit.end()], font=font, fill=GOLD)


def _draw_header(image: Image.Image, visual: dict, canvas, font_path, kicker_default="NA FONTE") -> int:
    """Draw standardized OS4 badge, handle and kicker. Returns the Y coordinate below header."""
    w, h, short = canvas.width, canvas.height, min(canvas.width, canvas.height)
    draw = ImageDraw.Draw(image, "RGBA")
    left = int(w * 0.075)
    font_brand = ImageFont.truetype(str(font_path), max(12, round(short * 0.027)))
    font_small = ImageFont.truetype(str(font_path), max(10, round(short * 0.019)))

    draw.text((left, int(h * 0.052)), CHANNEL_BADGE, font=font_brand, fill=WHITE)
    draw.text((left, int(h * 0.086)), CHANNEL_HANDLE, font=font_small, fill=GOLD)
    draw.line((left, int(h * 0.124), int(w * 0.925), int(h * 0.124)), fill=GOLD_FAINT, width=max(1, round(short * 0.002)))

    kicker = visual.get("kicker") or kicker_default
    if kicker:
        draw.text((left, int(h * 0.155)), str(kicker).upper(), font=font_small, fill=GOLD)
        return int(h * 0.190)
    return int(h * 0.160)


def video_box_bottom(canvas) -> Tuple[int, int, int, int]:
    """Lower-positioned video window when top infographics need space."""
    w, h = canvas.width, canvas.height
    width = 2 * round(w * (0.80 if canvas.portrait else 0.40) / 2)
    height = 2 * round(width * 9 / 16 / 2)
    return (
        round(w * (0.10 if canvas.portrait else 0.52)),
        round(h * (0.58 if canvas.portrait else 0.35)),
        width,
        height,
    )


def render_beat_frame(
    beat: MotionBeat,
    scene: dict,
    canvas,
    font_path,
    entrance: float = 1.0,
    icon_frame: int = 36,
    credit: str = "",
) -> Image.Image:
    """Render a fully composed Black Dark frame for a specific MotionBeat."""
    w, h, short = canvas.width, canvas.height, min(canvas.width, canvas.height)
    image = _background(w, h).copy()
    visual = scene.get("visual") or {}
    data = beat.data
    left = int(w * 0.075)
    right = int(w * 0.925)
    usable_w = right - left
    rounded = max(8, round(short * 0.027))
    gap = max(7, round(short * 0.016))
    pad = round(short * 0.04)
    icon_size = max(32, round(short * 0.112))
    font_small = ImageFont.truetype(str(font_path), max(10, round(short * 0.019)))

    # 1. Header
    header_bottom = _draw_header(image, visual, canvas, font_path)
    draw = ImageDraw.Draw(image, "RGBA")

    # 2. Source video cut-out window (if not hidden)
    vx, vy, vw, vh = (0, 0, 0, 0)
    if beat.video_mode == "bottom":
        vx, vy, vw, vh = video_box_bottom(canvas)
    elif beat.video_mode == "window":
        vx, vy, vw, vh = video_box(canvas)

    if beat.video_mode in ("window", "bottom"):
        image = _panel_backlight(image, (vx, vy, vw, vh), canvas=canvas)
        shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle(
            (vx - 4, vy + 10, vx + vw + 4, vy + vh + 20),
            radius=rounded + 5,
            fill=(0, 0, 0, 180),
        )
        image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(max(5, round(short * 0.030)))))
        draw = ImageDraw.Draw(image, "RGBA")
        # Transparent cutout so FFmpeg composite shows video underneath
        draw.rounded_rectangle((vx, vy, vx + vw - 1, vy + vh - 1), radius=rounded, fill=(0, 0, 0, 0))
        draw.rounded_rectangle(
            (vx - 2, vy - 2, vx + vw + 1, vy + vh + 1),
            radius=rounded + 2,
            outline=(207, 170, 102, 125),
            width=max(1, int(short * 0.002)),
        )

    # Icon renderer helper
    def put_icon(px, py, icon_key=None):
        try:
            name = icon_name(icon_key or data.get("icon") or "line-md:chat")
            icon = _icon_frame(name, icon_size, min(36, icon_frame))
            image.alpha_composite(icon, (int(px), int(py)))
        except (OSError, ValueError, ImportError):
            pass

    # 3. Dynamic component dispatch based on beat_type
    btype = beat.beat_type

    if btype == "metric":
        # Dominant visual figure with explanation and optional diff badge
        val = str(data.get("value") or data.get("figure") or "0")
        label = str(data.get("label") or data.get("subtext") or data.get("title") or "")
        diff = str(data.get("diff") or "")
        
        # Panel bounds
        top_y = header_bottom + int(short * 0.02)
        bottom_y = (vy - gap) if beat.video_mode == "bottom" else int(h * 0.76)
        panel = (left, top_y, right, bottom_y)

        draw.rounded_rectangle(panel, radius=rounded, fill=SURFACE_RAISED, outline=(202, 163, 88, 140), width=2)
        put_icon(right - icon_size - gap, top_y + gap)

        dy = round(short * 0.025 * (1.0 - entrance))
        val_area = (left + pad, top_y + pad + dy, right - pad - icon_size, top_y + int((bottom_y - top_y) * 0.55) + dy)
        fit_val = _fit(val, val_area, font_path, max(26, round(short * 0.18)), max(16, round(short * 0.08)), "metric val")
        _multiline(draw, fit_val, GOLD)

        if diff:
            # Diff tag (ex: +32,8%)
            tag_font = ImageFont.truetype(str(font_path), max(12, round(short * 0.024)))
            tag_text = diff if diff.startswith(("+", "-")) else f"+{diff}"
            tag_color = (80, 200, 120, 255) if not diff.startswith("-") else RED_ACCENT
            draw.text((left + pad, top_y + int((bottom_y - top_y) * 0.58) + dy), tag_text, font=tag_font, fill=tag_color)

        if label:
            lbl_top = top_y + int((bottom_y - top_y) * (0.64 if diff else 0.55))
            lbl_area = (left + pad, lbl_top + dy, right - pad, bottom_y - pad)
            fit_lbl = _fit(label, lbl_area, font_path, max(14, round(short * 0.045)), max(11, round(short * 0.024)), "metric lbl")
            _multiline(draw, fit_lbl, WHITE)

    elif btype == "strike_comparison":
        # List of items where selected item is visibly struck through
        items = data.get("items") or ["Item 1", "Item 2"]
        strike_idx = int(data.get("strike_index", 1))
        summary = str(data.get("summary") or "")

        top_y = header_bottom + int(short * 0.02)
        bottom_y = (vy - gap) if beat.video_mode == "bottom" else int(h * 0.76)
        panel = (left, top_y, right, bottom_y)
        draw.rounded_rectangle(panel, radius=rounded, fill=SURFACE, outline=(202, 163, 88, 115), width=2)
        put_icon(right - icon_size - gap, top_y + gap)

        dy = round(short * 0.02 * (1.0 - entrance))
        cur_y = top_y + pad + dy
        item_font = ImageFont.truetype(str(font_path), max(13, round(short * 0.038)))
        line_h = max(24, round(short * 0.055))

        for idx, item_txt in enumerate(items):
            is_struck = idx == strike_idx
            color = MUTED if is_struck else WHITE
            draw.text((left + pad, cur_y), item_txt, font=item_font, fill=color)
            if is_struck and entrance > 0.3:
                # Animated strike-through line
                strike_progress = min(1.0, (entrance - 0.3) / 0.7)
                txt_w = draw.textlength(item_txt, font=item_font)
                strike_w = txt_w * strike_progress
                sy = cur_y + line_h // 2
                draw.line([(left + pad, sy), (left + pad + strike_w, sy)], fill=RED_ACCENT, width=max(2, round(short * 0.005)))
            cur_y += line_h + gap

        if summary:
            draw.line((left + pad, cur_y + gap, right - pad, cur_y + gap), fill=GOLD_FAINT, width=1)
            cur_y += gap * 2
            sum_font = ImageFont.truetype(str(font_path), max(12, round(short * 0.028)))
            draw.text((left + pad, cur_y), summary.upper(), font=sum_font, fill=GOLD)

    elif btype == "comparison":
        # Two side-by-side cards with active highlight
        left_lbl = str(data.get("left_label") or "01 / ANTES")
        left_txt = str(data.get("left_text") or "")
        right_lbl = str(data.get("right_label") or "02 / DEPOIS")
        right_txt = str(data.get("right_text") or "")
        active_side = data.get("active_side", "right")

        top_y = header_bottom + int(short * 0.02)
        bottom_y = (vy - gap) if beat.video_mode == "bottom" else int(h * 0.76)
        col_w = (usable_w - gap) // 2

        for i, (lbl, txt, side_key) in enumerate([(left_lbl, left_txt, "left"), (right_lbl, right_txt, "right")]):
            is_act = active_side in (side_key, "both")
            x0 = left + i * (col_w + gap)
            x1 = x0 + col_w
            fill_col = SURFACE_RAISED if is_act else SURFACE
            border_col = (202, 163, 88, 215) if is_act else (95, 103, 115, 90)
            draw.rounded_rectangle((x0, top_y, x1, bottom_y), radius=max(6, rounded // 2), fill=fill_col, outline=border_col, width=2)
            draw.text((x0 + gap, top_y + gap), lbl, font=font_small, fill=GOLD if is_act else MUTED)
            area = (x0 + gap, top_y + int(short * 0.08), x1 - gap, bottom_y - gap)
            item = _fit(txt, area, font_path, max(13, round(short * 0.045)), max(11, round(short * 0.021)), f"comp {i}")
            _multiline(draw, item, WHITE if is_act else (148, 148, 148, 255))
        put_icon(right - icon_size - gap, top_y + gap)

    elif btype == "document_card":
        # Formal statement / notice with issuer and status stamp
        issuer = str(data.get("issuer") or "DOCUMENTO OFICIAL").upper()
        date_str = str(data.get("date") or "")
        text_content = str(data.get("text") or data.get("title") or "")
        stamp = str(data.get("stamp") or "").upper()

        top_y = header_bottom + int(short * 0.02)
        bottom_y = (vy - gap) if beat.video_mode == "bottom" else int(h * 0.76)
        panel = (left, top_y, right, bottom_y)
        draw.rounded_rectangle(panel, radius=rounded, fill=SURFACE_RAISED, outline=(222, 198, 155, 130), width=2)

        # Issuer bar
        draw.text((left + pad, top_y + pad), f"{issuer} {date_str}".strip(), font=font_small, fill=GOLD)
        put_icon(right - icon_size - gap, top_y + gap)

        dy = round(short * 0.02 * (1.0 - entrance))
        area = (left + pad, top_y + pad * 2 + dy, right - pad, bottom_y - pad - (round(short * 0.06) if stamp else 0))
        item = _fit(text_content, area, font_path, max(14, round(short * 0.048)), max(11, round(short * 0.024)), "doc text")
        _multiline(draw, item, WHITE)

        if stamp:
            # Stamp badge (e.g. INVERÍDICO or CONFIRMADO)
            s_font = ImageFont.truetype(str(font_path), max(11, round(short * 0.026)))
            s_w = draw.textlength(stamp, font=s_font) + pad
            s_box = (right - pad - int(s_w), bottom_y - pad - round(short * 0.045), right - pad, bottom_y - pad)
            s_border = RED_ACCENT if "INVER" in stamp or "FALSO" in stamp else GOLD
            draw.rounded_rectangle(s_box, radius=4, outline=s_border, width=2)
            draw.text((s_box[0] + pad // 2, s_box[1] + 2), stamp, font=s_font, fill=s_border)

    elif btype == "quote_card":
        # Stylized quote with opening quotation mark and gold bar
        quote_text = str(data.get("quote") or data.get("statement") or data.get("title") or "")
        author = str(data.get("author") or "")

        top_y = header_bottom + int(short * 0.02)
        bottom_y = (vy - gap) if beat.video_mode == "bottom" else int(h * 0.76)
        panel = (left, top_y, right, bottom_y)
        draw.rounded_rectangle(panel, radius=rounded, fill=(15, 15, 15, 255), outline=(222, 198, 155, 132), width=2)
        draw.rounded_rectangle((left + pad, top_y + int(short * 0.06), left + pad + max(4, round(short * 0.007)), bottom_y - pad), radius=2, fill=GOLD)

        qfont = ImageFont.truetype(str(font_path), max(36, round(short * 0.11)))
        draw.text((left + pad, top_y + gap), "“", font=qfont, fill=(202, 163, 88, 220))
        put_icon(right - icon_size - gap, top_y + gap)

        dy = round(short * 0.02 * (1.0 - entrance))
        area = (left + pad * 2 + int(short * 0.014), top_y + int(short * 0.08) + dy, right - pad, bottom_y - pad - (gap * 2 if author else 0))
        item = _fit(quote_text, area, font_path, max(13, round(short * 0.052)), max(11, round(short * 0.024)), "quote beat")
        _multiline(draw, item, WHITE)

        if author:
            draw.text((left + pad * 2 + int(short * 0.014), bottom_y - pad), f"— {author}", font=font_small, fill=GOLD)

    elif btype == "source_focus":
        # Video in primary window, with clean lower third pill
        title_txt = str(data.get("title") or visual.get("title") or "A FALA ORIGINAL")
        label = str(data.get("label") or "")
        pill_w = min(vw - gap * 2, int(vw * 0.72))
        pill_h = max(round(short * 0.064), int(vh * 0.20))
        pill = (vx + gap, vy + gap, vx + gap + pill_w, vy + gap + pill_h)
        draw.rounded_rectangle(pill, radius=round(pill_h * 0.22), fill=(9, 9, 9, 238), outline=(202, 163, 88, 145), width=max(1, round(short * 0.002)))
        put_icon(pill[0] + gap, pill[1] + (pill_h - icon_size) // 2)

        text_box = (pill[0] + icon_size + gap * 2, pill[1] + gap, pill[2] - gap, pill[3] - gap)
        support = _fit(label or title_txt, text_box, font_path, max(14, round(short * 0.032)), max(10, round(short * 0.021)), "focus label")
        _multiline(draw, support, WHITE)

    else:
        # Default headline beat
        title_txt = str(data.get("title") or visual.get("title") or "A FALA ORIGINAL")
        emphasis = str(data.get("emphasis") or "")
        top_y = header_bottom + int(short * 0.02)
        bottom_y = vy - gap if beat.video_mode in ("window", "bottom") else int(h * 0.65)
        titlebox = (left, top_y, right, bottom_y)
        titleitem = _fit(title_txt.upper(), titlebox, font_path, round(short * 0.098), max(16, round(short * 0.045)), "headline title")
        dy = round(short * 0.025 * (1.0 - entrance))
        _multiline(draw, titleitem, WHITE, dy)
        _highlight_title(image, titleitem, emphasis.upper(), dy)
        x1, y1, x2, y2 = titleitem["bounds"]
        width_line = int(min(x2 - x1, w * 0.33) * entrance)
        draw.line(
            (left, min(int(h * 0.383), y2 + int(short * 0.018)), left + width_line, min(int(h * 0.383), y2 + int(short * 0.018))),
            fill=GOLD,
            width=max(2, int(short * 0.004)),
        )

    if credit:
        draw = ImageDraw.Draw(image)
        draw.text((left, int(h * 0.932)), str(credit)[:100], font=font_small, fill=MUTED)

    return image


def dark_overlay(
    scene,
    *,
    canvas,
    font_path,
    stage: int = -1,
    entrance: float = 1.0,
    icon_frame: int = 30,
    credit: str = "",
) -> Image.Image:
    """Legacy compatibility bridge for existing tests and classic single overlays."""
    timeline = resolve_scene_timeline(scene, 10.0, ())
    target_idx = max(0, min(stage, len(timeline) - 1)) if stage >= 0 else 0
    beat = timeline[target_idx]
    if stage < 0:
        beat.video_mode = "window"
    return render_beat_frame(
        beat,
        scene,
        canvas=canvas,
        font_path=font_path,
        entrance=entrance,
        icon_frame=icon_frame,
        credit=credit,
    )


def motion_dark_sequence(
    scene: dict,
    folder: Path | str,
    *,
    canvas,
    font_path,
    duration: float,
    words: list = (),
    credit: str = "",
):
    """Render a multi-beat dynamic PNG sequence and ffconcat playlist."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    beats = resolve_scene_timeline(scene, duration, words)
    fps = canvas.fps
    total_frames = max(1, round(duration * fps))
    entries = ["ffconcat version 1.0"]
    last_path = None

    def append(path: Path, count: int):
        nonlocal last_path
        if count <= 0:
            return
        last_path = str(path.resolve()).replace("\\", "/").replace("'", "'\\''")
        entries.extend([f"file '{last_path}'", f"option framerate {fps}", f"duration {count / fps:.9f}"])

    previous_frame = None

    for beat_idx, beat in enumerate(beats):
        b_start = min(total_frames, math.ceil(beat.start_time * fps - 1e-8))
        b_end = min(total_frames, math.ceil(beat.end_time * fps - 1e-8))
        count = b_end - b_start
        if count <= 0:
            continue

        # Dynamic entrance duration (~0.45s)
        trans_duration = min(count, max(1, round(fps * 0.45)))

        for i in range(trans_duration - 1):
            ease = 1.0 - (1.0 - (i + 1) / trans_duration) ** 3
            current = render_beat_frame(
                beat,
                scene,
                canvas=canvas,
                font_path=font_path,
                entrance=ease,
                icon_frame=round(i * 30 / fps),
                credit=credit,
            )
            if previous_frame is not None:
                # Smooth cross-fade during transition
                current = Image.blend(previous_frame, current, ease)
            p = folder / f"dark-beat{beat_idx:02d}-trans{i:02d}.png"
            current.save(p, compress_level=2)
            append(p, 1)

        # Steady hold for remainder of this beat
        hold_frame = render_beat_frame(
            beat,
            scene,
            canvas=canvas,
            font_path=font_path,
            entrance=1.0,
            icon_frame=36,
            credit=credit,
        )
        p = folder / f"dark-beat{beat_idx:02d}-hold.png"
        hold_frame.save(p, compress_level=3)
        append(p, count - trans_duration + 1)
        previous_frame = hold_frame

    if last_path is None:
        raise ValueError("A timeline do Motion Dark gerou zero frames.")

    entries.extend([f"file '{last_path}'", f"option framerate {fps}"])
    concat_file = folder / "motion-dark.ffconcat"
    concat_file.write_text("\n".join(entries) + "\n", encoding="utf-8")
    timing_records = [
        {
            "id": b.id,
            "type": b.beat_type,
            "start": round(b.start_time, 3),
            "end": round(b.end_time, 3),
            "anchor": b.anchor,
            "video_mode": b.video_mode,
            "data": b.data,
        }
        for b in beats
    ]
    return concat_file, timing_records
