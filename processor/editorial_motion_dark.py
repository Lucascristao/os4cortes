"""Automatic OS4 Motion Dark compositing. Python/Pillow + FFmpeg; no paid media calls.

Ships the original MIT-licensed Line MD SVGs; converts SMIL stroke animation into
time-indexed SVG snapshots rendered with CairoSVG, rather than substituting icon glyphs.
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

MOTION_DARK_STYLE_VERSION = "os4-motion-dark-v1-lit-line-md"
ASSETS = Path(__file__).resolve().parent / "assets" / "line_md"
ICON_NAMES = ("confirm-circle", "alert-circle", "chat", "clipboard-check")
LAYOUT_NAMES = ("source_card", "statement", "comparison", "quote", "number")
GOLD = (202, 163, 88, 255)
WHITE = (249, 247, 241, 255)
MUTED = (180, 188, 198, 255)
NS = "{http://www.w3.org/2000/svg}"


def icon_name(value: str) -> str:
    name = str(value).removeprefix("line-md:")
    if name not in ICON_NAMES:
        raise ValueError(f"Icon not in the local Line MD catalogue: {value}")
    return name


def _seconds(value: str) -> float:
    return float(str(value or "0").rstrip("s"))


@lru_cache(maxsize=120)
def _icon_frame(name: str, pixel_size: int, frame: int) -> Image.Image:
    """Sample the actual stroke-dashoffset keyframes from the shipped SVG."""
    import cairosvg
    name = icon_name(name)
    root = ET.fromstring((ASSETS / (name + ".svg")).read_text(encoding="utf-8").replace("currentColor", "#CAA358"))
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
                dur = max(.001, _seconds(child.get("dur", ".1")))
                amount = min(1., max(0., (t - begin) / dur))
                parent.set("stroke-dashoffset", f"{start + (stop - start) * amount:.4f}")
            parent.remove(child)
    data = cairosvg.svg2png(bytestring=ET.tostring(root), output_width=pixel_size,
                            output_height=pixel_size)
    return Image.open(BytesIO(data)).convert("RGBA")


@lru_cache(maxsize=8)
def _background(width: int, height: int) -> Image.Image:
    """Multiple illuminated planes + gentle vignette: no flat opaque slab."""
    base = Image.new("RGBA", (width, height), (14, 17, 23, 255))
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow, "RGBA")
    draw.ellipse((-width*.65, -height*.35, width*.8, height*.61), fill=(161, 116, 60, 92))
    draw.ellipse((width*.3, height*.4, width*1.6, height*1.4), fill=(42, 70, 100, 58))
    base = Image.alpha_composite(base, glow.filter(ImageFilter.GaussianBlur(max(15, width*.17))))
    texture = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(texture, "RGBA")
    for y in range(0, height, max(7, round(height*.010))):
        draw.line((0, y, width, y), fill=(210, 205, 186, 7), width=1)
    for x in range(max(14, round(width*.045)), width, max(28, round(width*.09))):
        draw.line((x, 0, x, height), fill=(205, 199, 181, 4))
    for i in range(11):
        alpha = int(2 + i*1.4)
        inset = i * max(2, round(min(width,height)*.003))
        draw.rectangle((inset, inset, width-inset-1, height-inset-1),
                       outline=(0, 0, 0, alpha), width=max(1, round(width*.006)))
    # Composite texture onto the opaque gradient instead of replacing alpha.
    return Image.alpha_composite(base, texture)


def _multiline(draw, item, fill, dy=0):
    if not item:
        return
    xy = item["xy"]
    draw.multiline_text((xy[0], xy[1]+dy), item["text"], font=item["font"],
                        spacing=item["spacing"], fill=fill)


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
        width_before = draw.textlength(line[:hit.start()], font=font)
        line_height = (font.size + item["spacing"])
        xy = (item["xy"][0] + width_before, item["xy"][1] + lineno*line_height + yshift)
        draw.text(xy, line[hit.start():hit.end()], font=font, fill=GOLD)


def dark_overlay(scene, *, canvas, font_path, stage=-1, entrance=1.,
                 icon_frame=30, credit="") -> Image.Image:
    """Draw title/meaning cards around the reserved video/caption area."""
    w, h, short = canvas.width, canvas.height, min(canvas.width, canvas.height)
    visual = scene.get("visual") or {}
    motion = visual.get("motion") or {}
    layout = motion.get("layout", "source_card")
    name = icon_name(motion.get("icon", "line-md:chat"))
    accent = motion.get("emphasis", "")
    image = _background(w, h).copy()
    draw = ImageDraw.Draw(image, "RGBA")
    left = int(w*.075)
    font_brand = ImageFont.truetype(str(font_path), max(12, round(short*.027)))
    font_small = ImageFont.truetype(str(font_path), max(10, round(short*.019)))
    draw.text((left, int(h*.052)), CHANNEL_BADGE, font=font_brand, fill=WHITE)
    draw.text((left, int(h*.086)), CHANNEL_HANDLE, font=font_small, fill=GOLD)
    draw.line((left, int(h*.124), int(w*.925), int(h*.124)),
              fill=(203, 163, 88, 90), width=max(1, round(short*.002)))
    kicker = visual.get("kicker") if scene.get("kind") == "narration" else "NA FONTE"
    if kicker:
        draw.text((left, int(h*.160)), kicker.upper(), font=font_small, fill=GOLD)
    title = visual.get("title", "A FALA ORIGINAL") if scene.get("kind") == "narration" else "A FALA ORIGINAL"
    titlebox = (left, int(h*.202), int(w*.920), int(h*.372))
    titleitem = _fit(title.upper(), titlebox, font_path, round(short*.102),
                     max(16, round(short*.047)), "motion title")
    dy = round(short*.03*(1-entrance))
    _multiline(draw, titleitem, WHITE, dy)
    _highlight_title(image, titleitem, accent.upper(), dy)
    x1, y1, x2, y2 = titleitem["bounds"]
    width_line = int(min(x2-x1, w*.33)*entrance)
    draw.line((left, min(int(h*.383),y2+int(short*.018)),
               left+width_line, min(int(h*.383),y2+int(short*.018))), fill=GOLD, width=max(2, int(short*.004)))

    vx, vy, vw, vh = video_box(canvas)
    rounded = max(8, round(short*.027))
    shadow = Image.new("RGBA", (w,h),(0,0,0,0))
    ImageDraw.Draw(shadow).rounded_rectangle((vx-4, vy+10, vx+vw+4, vy+vh+20),
                   radius=rounded+5, fill=(0,0,0,180))
    image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(max(5,short*.030))))
    draw = ImageDraw.Draw(image, "RGBA")
    if stage < 0:
        # Transparent rounded window reveals actual video in the FFmpeg underlay.
        draw.rounded_rectangle((vx,vy,vx+vw-1,vy+vh-1),radius=rounded,fill=(0,0,0,0))
        draw.rounded_rectangle((vx-2,vy-2,vx+vw+1,vy+vh+1),radius=rounded+2,
                               outline=(207,170,102,125),width=max(1,int(short*.002)))
    else:
        # Deliberately distinct visual grammar per layout. Only selected
        # source-card retains the full moving interview in its real window.
        lines = visual.get("lines", ())
        content = lines[min(stage, len(lines)-1)] if lines else title
        gap = max(7, round(short*.016))
        panel = (vx, vy, vx+vw-1, vy+vh-1)
        pad = round(short*.04)
        icon_size = max(32, round(short*.112))
        def put_icon(px, py):
            try:
                icon = _icon_frame(name, icon_size, min(36, icon_frame))
                image.alpha_composite(icon, (int(px), int(py)))
            except (OSError, ValueError, ImportError):
                # Optional graphical ornament never invalidates literal speech.
                pass

        if layout == "source_card":
            # Avoid an opaque full-screen card over the actual speaker.
            draw.rounded_rectangle(panel, radius=rounded, fill=(0,0,0,0))
            pill_w = min(vw-gap*2, int(vw*.70))
            pill_h = max(round(short*.064), int(vh*.20))
            pill=(vx+gap, vy+gap, vx+gap+pill_w, vy+gap+pill_h)
            draw.rounded_rectangle(pill, radius=round(pill_h*.22), fill=(17,22,31,228),
                                   outline=(202,163,88,145), width=max(1,round(short*.002)))
            put_icon(pill[0]+gap, pill[1]+(pill_h-icon_size)//2)
            draw = ImageDraw.Draw(image, "RGBA")
            text_box=(pill[0]+icon_size+gap*2,pill[1]+gap,pill[2]-gap,pill[3]-gap)
            support=_fit(content,text_box,font_path,max(14,round(short*.032)),
                         max(10,round(short*.021)),"motion source label")
            _multiline(draw,support,WHITE)
        elif layout == "comparison" and len(lines) > 1:
            # Two equal volumes with directional lighting; reveal meaning
            # sequentially, rather than replacing one generic card.
            margin = max(8,round(short*.018))
            col=(vw-margin*3)//2
            card_w=max(30,col)
            for i in range(min(2,len(lines))):
                x0=vx+margin+i*(card_w+margin)
                y0=vy+margin
                xend=x0+card_w
                active=i<=stage
                draw.rounded_rectangle((x0,y0,xend,vy+vh-margin),
                                       radius=max(8,rounded//2),
                                       fill=(43,36,29,255) if active else (25,29,36,255),
                                       outline=(202,163,88,215) if active else (95,103,115,90),width=2)
                label="01 / ANTES" if i==0 else "02 / DEPOIS"
                draw.text((x0+gap,y0+gap), label, font=font_small,
                          fill=GOLD if active else MUTED)
                textbox=(x0+gap,y0+int(vh*.27),xend-gap,vy+vh-margin-gap)
                item=_fit(lines[i],textbox,font_path,max(13,round(short*.047)),
                          max(11,round(short*.021)),f"motion comparison {i}")
                _multiline(draw,item,WHITE if active else (154,160,166,255),
                           round(short*.016*(1-entrance)) if i==stage else 0)
            put_icon(vx+vw-icon_size-gap,vy+gap)
        elif layout == "quote":
            # Quoted content remains visibly attributed and unlike a statistic.
            draw.rounded_rectangle(panel,radius=rounded,fill=(37,39,43,255),
                                   outline=(222,198,155,132),width=2)
            draw.rounded_rectangle((vx+pad,vy+int(vh*.18),vx+pad+max(4,round(short*.007)),vy+vh-pad),
                                   radius=2,fill=GOLD)
            qfont=ImageFont.truetype(str(font_path),max(40,round(short*.12)))
            draw.text((vx+pad,vy), "“", font=qfont, fill=(202,163,88,220))
            area=(vx+pad*2+int(short*.014),vy+int(vh*.22),
                  vx+vw-pad,vy+vh-pad-int(short*.012))
            item=_fit(content,area,font_path,max(13,round(short*.054)),
                      max(11,round(short*.026)),"motion quote")
            _multiline(draw,item,WHITE,round(short*.02*(1-entrance)))
            put_icon(vx+vw-icon_size-gap,vy+gap)
        elif layout == "number":
            # A real number from the supplied text becomes the dominant visual.
            draw.rounded_rectangle(panel,radius=rounded,fill=(24,29,37,255),
                                   outline=(202,163,88,115),width=2)
            match=re.search(r"(?<!\w)\d[\d.,%]*",content) or re.search(r"(?<!\w)\d[\d.,%]*",title)
            figure=match.group(0) if match else ""
            if figure:
                figure_area=(vx+pad,vy+int(vh*.13),vx+vw-pad,vy+int(vh*.65))
                item=_fit(figure,figure_area,font_path,max(18,round(short*.15)),
                          max(14,round(short*.065)),"motion number")
                _multiline(draw,item,GOLD,round(short*.018*(1-entrance)))
            explanation=re.sub(re.escape(figure),"",content,count=1).strip(" :-–—") if figure else content
            if explanation:
                area=(vx+pad,vy+int(vh*.67),vx+vw-pad,vy+vh-pad)
                item=_fit(explanation,area,font_path,max(12,round(short*.039)),
                          max(10,round(short*.022)),"motion number explanation")
                _multiline(draw,item,WHITE)
            put_icon(vx+vw-icon_size-gap,vy+gap)
        else:
            # Statement: illuminated type and a slim gold marker, not a paper card.
            draw.rounded_rectangle(panel,radius=rounded,fill=(25,29,36,255),
                                   outline=(203,163,88,115),width=2)
            draw.rounded_rectangle((vx+pad,vy+int(vh*.27),vx+pad+int(short*.008),
                                    vy+vh-pad),radius=2,fill=GOLD)
            area=(vx+pad*2,vy+int(vh*.31),vx+vw-pad,vy+vh-pad)
            item=_fit(content,area,font_path,max(14,round(short*.065)),
                      max(11,round(short*.031)),"motion statement")
            _multiline(draw,item,WHITE,round(short*.022*(1-entrance)))
            put_icon(vx+vw-icon_size-gap,vy+gap)
    if credit:
        draw=ImageDraw.Draw(image)
        draw.text((left,int(h*.932)),credit[:100],font=font_small,fill=MUTED)
    return image


def motion_dark_sequence(scene, folder, *, canvas, font_path, duration, words=(), credit=""):
    """Finite cached PNG animation: 30fps entrance, hold static frames afterward."""
    folder=Path(folder)
    folder.mkdir(parents=True,exist_ok=True)
    timeline=paper_timeline(scene,duration,words)
    fps=canvas.fps
    total=max(1,round(duration*fps))
    entries=["ffconcat version 1.0"]
    previous=None
    last=None
    def append(path,frames):
        nonlocal last
        if frames<=0: return
        last=str(path.resolve()).replace("\\","/").replace("'","'\\''")
        entries.extend([f"file '{last}'",f"option framerate {fps}",f"duration {frames/fps:.9f}"])
    for index,step in enumerate(timeline):
        begin=min(total,math.ceil(step["start"]*fps-1e-8))
        end=min(total,math.ceil(step["end"]*fps-1e-8))
        count=end-begin
        if count<=0:continue
        duration_entrance=min(count,max(1,round(fps*.95)))
        for i in range(duration_entrance-1):
            ease=1-(1-(i+1)/duration_entrance)**3
            current=dark_overlay(scene,canvas=canvas,font_path=font_path,
                                 stage=step["stage"],entrance=ease,icon_frame=round(i*30/fps),credit=credit)
            if previous is not None:
                # Transition between two fully composed planes.
                current=Image.blend(previous,current,ease)
            path=folder/f"dark-{index:02d}-{i:02d}.png"
            current.save(path,compress_level=3)
            append(path,1)
        current=dark_overlay(scene,canvas=canvas,font_path=font_path,
                             stage=step["stage"],entrance=1.,icon_frame=36,credit=credit)
        path=folder/f"dark-{index:02d}-hold.png"
        current.save(path,compress_level=3)
        append(path,count-duration_entrance+1)
        previous=current
    if last is None:
        raise ValueError("Motion dark timeline is empty.")
    entries.extend([f"file '{last}'",f"option framerate {fps}"])
    concat=folder/"motion-dark.ffconcat"
    concat.write_text("\n".join(entries)+"\n",encoding="utf-8")
    return concat,timeline
