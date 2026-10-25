"""Optional paper-and-amber layouts, driven by existing editorial text/timing.

No model calls or asset searches. A bounded PNG sequence supplies the graphic
layers; the existing compositor supplies video, speech, captions and muxing.
"""
from __future__ import annotations

import math
from pathlib import Path
import re
import unicodedata

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .branding import CHANNEL_BADGE, CHANNEL_HANDLE

PAPER_STYLE_VERSION = "os4-paper-motion-v1"
PAPER = (237, 234, 226, 255)
INK = (24, 25, 24, 255)
AMBER = (159, 103, 0, 255)


def video_box(canvas):
    """Even-sized landscape window, clear of the established caption zone."""
    w, h = canvas.width, canvas.height
    width = 2 * round(w * (.84 if canvas.portrait else .44) / 2)
    height = 2 * round(width * 9 / 16 / 2)
    return (round(w * (.075 if canvas.portrait else .49)),
            round(h * (.40 if canvas.portrait else .20)), width, height)


def _tokens(value):
    plain = ''.join(c for c in unicodedata.normalize('NFKD', value.lower())
                    if not unicodedata.combining(c))
    return re.findall(r'\w+', plain)


def literal_anchor(words, text):
    """Ambiguous/rephrased text has no inferred semantic timing."""
    wanted, actual = _tokens(text), []
    if not wanted:
        return None
    for word in words:
        actual.extend((token, float(word['inicio'])) for token in _tokens(word['texto']))
    hits = [actual[i][1] for i in range(len(actual)-len(wanted)+1)
            if [item[0] for item in actual[i:i+len(wanted)]] == wanted]
    return hits[0] if len(hits) == 1 else None


def paper_timeline(scene, duration, words=()):
    """Keep speech intact; show at most three supports with readable holds.

Exact, unique literal matches use aligned words. Otherwise supports use paced
positions; no keyword-to-fact inference, guessed dates or synthesized quotes.
Short narration keeps the video layout rather than flashing unreadable cards.
"""
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Paper scene duration must be positive and finite.')
    steps = [{'start': 0., 'end': duration, 'stage': -1, 'timing': 'scene-start'}]
    if scene['kind'] != 'narration':
        return steps
    lines = scene.get('visual', {}).get('lines', [])
    cues = scene.get('tts', {}).get('cues', [])
    earliest = 1.4
    for index, line in enumerate(lines):
        # Long legacy text gets a longer hold, with no truncation.
        hold = max(1.4, min(4., len(line.split()) / 3.5))
        anchor = literal_anchor(words, line)
        timing = 'literal-support'
        if anchor is None and index < len(cues):
            anchor = literal_anchor(words, cues[index].get('text', ''))
            timing = 'literal-cue'
        if anchor is None:
            anchor = duration * (.32 + index * .58/max(1, len(lines)))
            timing = 'paced-fallback'
        start = max(earliest, anchor)
        if start + hold > duration:
            break
        steps[-1]['end'] = start
        steps.append({'start': start, 'end': duration, 'stage': index, 'timing': timing})
        earliest = start + hold
    return steps


def _wrap(draw, value, font, width):
    lines, line = [], ''
    for token in value.split():
        proposed = f'{line} {token}'.strip()
        if line and draw.textlength(proposed, font=font) > width:
            lines.append(line)
            line = token
        else:
            line = proposed
    if line:
        lines.append(line)
    return '\n'.join(lines)


def _fit(value, box, font_path, maximum, minimum, field):
    draw = ImageDraw.Draw(Image.new('L', (1, 1)))
    x, y, right, bottom = box
    for size in range(maximum, minimum-1, -1):
        font = ImageFont.truetype(str(font_path), size)
        wrapped = _wrap(draw, value, font, right-x)
        spacing = max(2, round(size*.12))
        bounds = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=spacing)
        if bounds[2]-bounds[0] <= right-x and bounds[3]-bounds[1] <= bottom-y:
            return {'text': wrapped, 'font': font, 'spacing': spacing,
                    'xy': (x-bounds[0], y-bounds[1]), 'box': box,
                    'bounds': (x, y, x+bounds[2]-bounds[0], y+bounds[3]-bounds[1])}
    raise ValueError(f'{field}: texto não cabe na área segura com fonte legível; revise este campo.')


def paper_layout(scene, *, canvas, font_path, credit=''):
    """Measure every support before voice/media work, including hidden stages."""
    w, h, short = canvas.width, canvas.height, min(canvas.width, canvas.height)
    portrait = canvas.portrait
    visual = scene.get('visual', {})
    title = visual.get('title', 'A fala original.')
    kicker = visual.get('kicker', '') if scene['kind'] == 'narration' else 'NA FONTE'
    title_box = (round(w*.075), round(h*(.205 if portrait else .24)),
                 round(w*(.915 if portrait else .44)), round(h*(.365 if portrait else .62)))
    vx, vy, vw, vh = video_box(canvas)
    pad = round(short*.036)
    body_box = (vx+pad, vy+round(vh*.28), vx+vw-pad, vy+vh-pad)
    layout = {
        'title': _fit(title, title_box, font_path, round(short*.105), max(12, round(short*.050)), 'visual.title'),
        'supports': [_fit(line, body_box, font_path, round(short*.052), max(12, round(short*.032)), f'visual.lines[{i}]')
                     for i, line in enumerate(visual.get('lines', []))],
        'kicker': None, 'credit': None, 'window': (vx, vy, vw, vh),
    }
    if kicker:
        layout['kicker'] = _fit(kicker.upper(),
            (round(w*.075), round(h*.16), round(w*.91), round(h*.195)),
            font_path, max(10, round(short*.022)), max(9, round(short*.016)), 'visual.kicker')
    if credit:
        layout['credit'] = _fit(credit,
            (round(w*.075), round(h*.935), round(w*.91), round(h*.972)),
            font_path, max(9, round(short*.018)), max(8, round(short*.013)), 'credit')
    return layout


def paper_overlay(scene, *, canvas, font_path, credit='', stage=-1, entrance=1.):
    """Opaque paper with a rounded video window, or a replacing support card."""
    layout = paper_layout(scene, canvas=canvas, font_path=font_path, credit=credit)
    w, h, short = canvas.width, canvas.height, min(canvas.width, canvas.height)
    image = Image.new('RGBA', (w, h), PAPER)
    draw = ImageDraw.Draw(image)
    # Very subtle ruled paper is deterministic and does not flicker frame to frame.
    for y in range(0, h, max(3, round(short*.006))):
        draw.line((0, y, w, y), fill=(235, 232, 224, 255))
    left = round(w*.075)
    badge_font = ImageFont.truetype(str(font_path), max(12, round(short*.026)))
    draw.text((left, round(h*.06)), CHANNEL_BADGE, font=badge_font, fill=INK)
    handle_font = ImageFont.truetype(str(font_path), max(9, round(short*.016)))
    draw.text((left, round(h*.091)), CHANNEL_HANDLE, font=handle_font, fill=AMBER)

    for name, color in (('kicker', AMBER), ('title', INK), ('credit', (104, 103, 95, 255))):
        item = layout[name]
        if not item:
            continue
        xy = item['xy']
        dy = round(short*.020*(1-entrance)) if name == 'title' else 0
        draw.multiline_text((xy[0], xy[1]+dy), item['text'], font=item['font'],
                            spacing=item['spacing'], fill=color)
        if name == 'title':
            box = item['bounds']
            y = box[3] + round(short*.015)
            draw.line((box[0], y, box[0]+round((box[2]-box[0])*entrance), y), fill=AMBER, width=max(2, round(short*.005)))

    vx, vy, vw, vh = layout['window']
    radius = round(short*.025)
    shadow = Image.new('RGBA', (w, h))
    ImageDraw.Draw(shadow).rounded_rectangle((vx, vy+8, vx+vw, vy+vh+8), radius=radius, fill=(0, 0, 0, 45))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(max(2, short*.012))))
    draw = ImageDraw.Draw(image)
    if stage < 0:
        draw.rounded_rectangle((vx, vy, vx+vw-1, vy+vh-1), radius=radius, fill=(0, 0, 0, 0))
    else:
        draw.rounded_rectangle((vx, vy, vx+vw-1, vy+vh-1), radius=radius, fill=(251, 250, 246, 255))
        item = layout['supports'][stage]
        label_font = ImageFont.truetype(str(font_path), max(10, round(short*.019)))
        pad = round(short*.036)
        draw.text((vx+pad, vy+pad), f'{stage+1:02d} / EM FOCO', font=label_font, fill=AMBER)
        dy = round(short*.018*(1-entrance))
        draw.multiline_text((item['xy'][0], item['xy'][1]+dy), item['text'], font=item['font'],
                            spacing=item['spacing'], fill=INK)
        # A short accent is a visual marker, never a generated assertion/stamp.
        draw.line((vx+pad, vy+vh-pad//2, vx+vw-pad, vy+vh-pad//2), fill=(213, 190, 140, 255), width=max(1, round(short*.002)))
    return image


def paper_sequence(scene, folder, *, canvas, font_path, duration, words=(), credit=''):
    """Bounded animation assets: hold frames are decoded once, not saved at 30fps."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    timeline = paper_timeline(scene, duration, words)
    entries, previous, last = ['ffconcat version 1.0'], None, None
    total_frames = max(1, round(duration*canvas.fps))

    def append(path, frames):
        nonlocal last
        if frames <= 0:
            return
        last = str(path.resolve()).replace('\\', '/').replace("'", "'\\''")
        entries.extend([f"file '{last}'", f'option framerate {canvas.fps}', f'duration {frames/canvas.fps:.9f}'])

    for index, step in enumerate(timeline):
        begin = min(total_frames, math.ceil(step['start']*canvas.fps-1e-8))
        end = min(total_frames, math.ceil(step['end']*canvas.fps-1e-8))
        count = end-begin
        if count <= 0:
            continue
        current = paper_overlay(scene, canvas=canvas, font_path=font_path, credit=credit, stage=step['stage'])
        animation = min(count, max(1, round(canvas.fps*.28)))
        for frame in range(animation-1):
            eased = 1-(1-(frame+1)/animation)**3
            incoming = paper_overlay(scene, canvas=canvas, font_path=font_path, credit=credit,
                                     stage=step['stage'], entrance=eased)
            composed = Image.blend(previous, incoming, eased) if previous is not None else incoming
            path = folder/f'paper-{index:02d}-motion-{frame:02d}.png'
            composed.save(path, compress_level=3)
            append(path, 1)
        path = folder/f'paper-{index:02d}.png'
        current.save(path, compress_level=3)
        append(path, count-animation+1)
        previous = current
    if last is None:
        raise ValueError('Paper scene has no frames.')
    entries.extend([f"file '{last}'", f'option framerate {canvas.fps}'])
    concat = folder/'paper.ffconcat'
    concat.write_text('\n'.join(entries)+'\n', encoding='utf-8')
    return concat, timeline
