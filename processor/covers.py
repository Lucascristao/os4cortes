"""Source-only cover composition shared by simple and editorial renderers.

The package chooses a template and title. This module selects real source
frames and adapts the approved v3 presets to their detected faces. No generated
facial detail, fixed-person crop coordinates, voice or final-video cache is used.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import subprocess
import unicodedata
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from .lower_third import LowerThird


ASSETS = Path(__file__).resolve().parent / "assets" / "covers"
PRESET_FILE = ASSETS / "presets-v1.json"
PRESETS = json.loads(PRESET_FILE.read_text(encoding="utf-8"))
COVER_VERSION = PRESETS["version"]
TEMPLATE_IDS = ("01_central", "02_lateral", "03_close")
RETIRED_PAIR_TEMPLATE = "04_duas_pessoas"
TITLE_FONT = ASSETS / "fonts" / "ArchivoBlack-Regular.ttf"
CREDIT_FONT = ASSETS / "fonts" / "Inter-opsz-wght.ttf"
MAX_CANDIDATES = 60
# Reuse one source/range scan across native aspects and requested templates in
# a batch without retaining every cut's full-resolution source frames in RAM.
_FRAME_SELECTION_CACHE = {}


class CoverError(ValueError):
    """A cut cannot be delivered with a readable source-based cover."""


def _aspect(value):
    value = str(value).replace("x", ":")
    if value not in ("9:16", "16:9"):
        raise CoverError("cover: formato deve ser 9:16 ou 16:9.")
    return value


def default_template(aspect):
    return "01_central" if _aspect(aspect) == "9:16" else "02_lateral"


def normalize_cover(raw, title, aspect):
    """Validate metadata and migrate the retired pair layout to one real face."""
    aspect = _aspect(aspect)
    if raw is None:
        raw = {"version": 1, "template_id": default_template(aspect), "title": title}
    if not isinstance(raw, dict) or set(raw) != {"version", "template_id", "title"}:
        raise CoverError("cover: informe apenas version, template_id e title.")
    if type(raw["version"]) is not int or raw["version"] != 1:
        raise CoverError("cover.version: use 1.")
    identifier = raw["template_id"]
    if identifier == RETIRED_PAIR_TEMPLATE:
        identifier = default_template(aspect)
    if not isinstance(identifier, str) or identifier not in TEMPLATE_IDS:
        raise CoverError("cover.template_id: modelo de capa inválido.")
    text = raw["title"]
    if not isinstance(text, str) or not text.strip() or len(text) > 60:
        raise CoverError("cover.title: informe um título de capa não vazio com até 60 caracteres.")
    if (any(unicodedata.category(char).startswith("C") or char in "\u2028\u2029" for char in text)
            or re.search(r"[<>`]|\*\*|__|\[[^\]]*\]\(", text)):
        raise CoverError("cover.title: use texto simples, sem marcação ou quebras de linha.")
    return {"version": 1, "template_id": identifier, "title": text.strip()}


def _canonical_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def _file_hash(path):
    path = Path(path).resolve()
    stat = path.stat()
    return _content_hash(str(path), stat.st_size, stat.st_mtime_ns)


@lru_cache(maxsize=256)
def _content_hash(path, size, mtime_ns):
    del size, mtime_ns
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ranges(ranges):
    result = []
    for item in ranges:
        if isinstance(item, dict):
            start, end = item.get("start", item.get("inicio")), item.get("end", item.get("fim"))
        else:
            try:
                start, end = item
            except (TypeError, ValueError) as exc:
                raise CoverError("cover: intervalo original inválido.") from exc
        try:
            if isinstance(start, bool) or isinstance(end, bool):
                raise ValueError()
            start, end = float(start), float(end)
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                raise ValueError()
        except (TypeError, ValueError) as exc:
            raise CoverError("cover: intervalos originais precisam de início e fim válidos.") from exc
        result.append((start, end))
    if not result:
        raise CoverError("cover: nenhum trecho original disponível para selecionar o rosto.")
    return sorted(set(result))


def sample_timestamps(ranges, limit=MAX_CANDIDATES):
    """Evenly sample the union of selected clip ranges, never their envelope."""
    if not isinstance(limit, int) or not 1 <= limit <= MAX_CANDIDATES:
        raise CoverError("cover: a amostragem deve usar de 1 a 60 frames.")
    merged = []
    for start, end in _ranges(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    total = sum(end - start for start, end in merged)
    count = min(limit, max(1, math.ceil(total * 4)))
    # Temporal triplets permit two short mouth-motion comparisons per anchor,
    # while keeping the complete selection budget at 60 decoded source frames.
    groups = max(1, count//3)
    per_group = min(3, count)
    targets = [(index + .5) * total / groups for index in range(groups)]
    result, offset, current = [], 0.0, 0
    for target in targets:
        while target >= offset + merged[current][1] - merged[current][0] and current < len(merged) - 1:
            offset += merged[current][1] - merged[current][0]
            current += 1
        start, end = merged[current]
        center = start + target-offset
        margin = min(.001, (end-start)/10)
        step = min(.10, (end-start-margin*2)/max(1, per_group))
        first = max(start+margin, min(end-margin-step*(per_group-1), center-step*(per_group-1)/2))
        result.extend(round(first+index*step, 6) for index in range(per_group))
    return sorted(set(result))


def _cv2():
    try:
        import cv2
    except ImportError as exc:
        raise CoverError("cover: OpenCV/YuNet é obrigatório para selecionar rostos reais.") from exc
    return cv2


def _extract_frame_ffmpeg(source, timestamp, ffmpeg="ffmpeg"):
    """Extrai um frame exato via FFmpeg quando o decoder do OpenCV falha (ex: AV1)."""
    cmd = [
        str(ffmpeg), "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, float(timestamp)):.3f}",
        "-i", str(source),
        "-frames:v", "1",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-q:v", "2",
        "pipe:1"
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        if proc.returncode == 0 and proc.stdout:
            cv2 = _cv2()
            arr = np.frombuffer(proc.stdout, dtype=np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if frame is not None and frame.size > 0:
                return frame
    except Exception:
        pass
    return None


def _lower_third(value):
    if value is None:
        return LowerThird()
    if isinstance(value, LowerThird):
        return value
    if isinstance(value, dict):
        return LowerThird(value.get("mode", "off"), value.get("height_fraction", 0))
    raise CoverError("cover: tratamento de tarja inválido.")


def _make_detector(width, height, work_dir):
    from .tracking import garantir_yunet
    cv2 = _cv2()
    model = garantir_yunet(work_dir)
    detect_width = min(1280, width)
    detect_height = max(1, round(height * detect_width / width))
    detector = cv2.FaceDetectorYN.create(str(model), "", (detect_width, detect_height), .70, .30, 5000)

    def detect(frame):
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (detect_width, detect_height))
        _, faces = detector.detect(small)
        if faces is None:
            return []
        sx, sy = w / detect_width, h / detect_height
        result = []
        for row in faces:
            x, y, fw, fh = [float(value) for value in row[:4]]
            landmarks = [[float(row[index])*sx, float(row[index+1])*sy] for index in range(4, 14, 2)]
            result.append({"box": [x*sx, y*sy, fw*sx, fh*sy], "confidence": float(row[-1]),
                           "landmarks": landmarks})
        return result
    return detect


def _eye_detail(gray, landmarks, face_box):
    """A weak detail score, not an eye-open classifier or an identity model.

    A thin dark eyelid can inflate global Laplacian sharpness. Contrast spread
    around YuNet's two eye landmarks reduces that preference. Shadowed/profile
    faces receive a neutral value when the local signal is insufficient.
    """
    if not isinstance(landmarks, list) or len(landmarks) < 2:
        return .5
    x, y, fw, fh = face_box
    values = []
    for eye in landmarks[:2]:
        ex, ey = eye[0]-x, eye[1]-y
        half_w, half_h = max(4, round(fw*.095)), max(3, round(fh*.045))
        left, right = max(0, round(ex)-half_w), min(gray.shape[1], round(ex)+half_w+1)
        top, bottom = max(0, round(ey)-half_h), min(gray.shape[0], round(ey)+half_h+1)
        region = gray[top:bottom, left:right].astype(float)
        if region.shape[0] < 5 or region.shape[1] < 7:
            continue
        contrast = float(np.percentile(region, 90)-np.percentile(region, 10))
        if contrast < 16:
            continue
        darkness = np.maximum(0, np.percentile(region, 55)-region)
        # Focus on the central iris/eyelid area instead of the eye corners.
        center = np.linspace(-1, 1, region.shape[1])
        darkness *= (1-np.abs(center)[None, :])
        rows = darkness.sum(axis=1)
        if rows.max() <= 0:
            continue
        useful = rows >= rows.max()*.55
        spread = float(useful.sum()) / len(rows)
        values.append(max(0.0, min(1.0, (spread-.10)/.35)))
    return float(sum(values)/len(values)) if values else .5


def _quality(frame, detection):
    cv2 = _cv2()
    height, width = frame.shape[:2]
    try:
        x, y, fw, fh = map(float, detection["box"])
        confidence = float(detection.get("confidence", 1))
    except (TypeError, ValueError, KeyError):
        return None
    if not all(math.isfinite(v) for v in (x, y, fw, fh, confidence)):
        return None
    # A tiny detection cannot produce a useful thumbnail; accept reasonable confidence
    if min(fw, fh) < 24 or fw*fh < width*height*.001 or confidence < .55:
        return None
    # Clamp face box to frame boundaries instead of dropping when touching the top/edge
    x1, y1 = max(0.0, x), max(0.0, y)
    x2, y2 = min(float(width), x + fw), min(float(height), y + fh)
    vis_w, vis_h = x2 - x1, y2 - y1
    if vis_w < 24 or vis_h < 24 or (vis_w * vis_h) < (fw * fh * 0.45):
        return None
    margin_x, margin_top, margin_bottom = fw*.12, fh*.20, fh*.12
    roi = frame[max(0, round(y1)):min(height, round(y2)), max(0, round(x1)):min(width, round(x2))]
    if not roi.size:
        return None
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    luminance = float(gray.mean())
    clipped = float(np.mean((gray <= 8) | (gray >= 247)))
    exposure = max(.05, 1-abs(luminance-132)/150) * (1-min(.85, clipped))
    area = fw*fh / (width*height)
    edge = min(1.0, max(0.0, x1-margin_x)/max(1, fw*.25),
               max(0.0, y1-margin_top)/max(1, fh*.25),
               max(0.0, width-x2-margin_x)/max(1, fw*.25),
               max(0.0, height-y2-margin_bottom)/max(1, fh*.25))
    eye_detail = _eye_detail(gray, detection.get("landmarks"), [x, y, fw, fh])
    score = (confidence * (area ** .55) * math.log1p(max(0, sharpness)) * exposure
             * (.65+.35*edge) * (.30+.70*eye_detail))
    if luminance < 15 or luminance > 245 or sharpness < 1.5:
        return None
    return {"box": [x, y, fw, fh], "confidence": round(confidence, 6),
            "landmarks": detection.get("landmarks"),
            "sharpness": round(sharpness, 4), "luminance": round(luminance, 4),
            "exposure": round(exposure, 6), "useful_area": round(area, 6),
            "framing": round(edge, 6), "eye_detail": round(eye_detail, 6), "score": round(score, 8)}


def _measure_activity(frame, face, previous_mouths, previous_foreheads):
    """Reuse tracking's mouth motion, discounting camera/head appearance changes."""
    from .tracking import calcular_movimento_labial
    cv2 = _cv2()
    height, width = frame.shape[:2]
    box = face["box"]
    activity, mouth = calcular_movimento_labial(frame, box, previous_mouths, width, height)
    x, y, fw, fh = box
    left, right = max(0, round(x+fw*.20)), min(width, round(x+fw*.80))
    top, bottom = max(0, round(y+fh*.10)), min(height, round(y+fh*.30))
    forehead = None
    head_motion = 0.0
    if right > left and bottom > top:
        stable = cv2.resize(cv2.cvtColor(frame[top:bottom, left:right], cv2.COLOR_BGR2GRAY), (24, 16))
        cx, cy = (x+fw/2)/width, (y+fh/2)/height
        matches = [item for item in previous_foreheads if math.hypot(cx-item[0], cy-item[1]) < .12]
        if matches:
            previous = min(matches, key=lambda item: math.hypot(cx-item[0], cy-item[1]))
            head_motion = float(cv2.absdiff(stable, previous[2]).mean())
        forehead = (cx, cy, stable)
    if mouth is not None:
        matches = [item for item in previous_mouths if math.hypot(mouth[0]-item[0], mouth[1]-item[1]) < .12]
        if matches:
            previous = min(matches, key=lambda item: math.hypot(mouth[0]-item[0], mouth[1]-item[1]))
            mouth_motion = float(cv2.absdiff(mouth[2], previous[2]).mean())
            corrected = .60*max(0, min(1, (mouth_motion-head_motion*1.15-2.0)/9))
            activity = min(activity, corrected)
        else:
            mouth_motion = 0.0
        # Carry the corrected EMA into the next frame of the same triplet.
        mouth = (*mouth[:3], activity)
    else:
        mouth_motion = 0.0
    return {"mouth_activity": round(activity, 6), "mouth_motion": round(mouth_motion, 6),
            "head_motion": round(head_motion, 6)}, mouth, forehead


def _layout_possible(size, faces, preset):
    if len(faces) < len(preset["photos"]):
        return False
    try:
        for face, destination in zip(faces, preset["photos"]):
            _, projected = _face_crop(size, face, destination, preset["face_fraction"], preset["face_center"])
            if _intersects(projected, preset["title"]["box"]):
                return False
    except CoverError:
        return False
    return True


def _select_frame(source, ranges, treatment, work_dir, *, detector=None, max_candidates=MAX_CANDIDATES,
                  aspect="9:16", template_id="01_central", ffmpeg="ffmpeg"):
    cv2 = _cv2()
    use_cache = detector is None
    stat = Path(source).stat()
    scan_key = (str(Path(source).resolve()), stat.st_size, stat.st_mtime_ns, tuple(ranges),
                treatment.mode, treatment.height_fraction, max_candidates)
    cached = _FRAME_SELECTION_CACHE.get(scan_key) if use_cache else None
    if cached is not None:
        best, scanned, usable, fallback_frame, fallback_meta = cached
        return _selected_photo(best, scanned, usable, aspect, template_id, cv2,
                               fallback_frame=fallback_frame, fallback_meta=fallback_meta)
    cap = cv2.VideoCapture(str(source))
    best, scanned, usable = {}, 0, 0
    fallback_frame = None
    fallback_meta = None
    previous_mouths, previous_foreheads = [], []
    previous_timestamp, previous_small = None, None
    try:
        times = sample_timestamps(ranges, max_candidates)
        for timestamp in times:
            raw = None
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_POS_MSEC, timestamp*1000)
                ok, raw_cap = cap.read()
                if ok and raw_cap is not None and getattr(raw_cap, "size", 0) > 0:
                    raw = raw_cap
            if raw is None:
                # Decodificação de contingência via FFmpeg quando OpenCV falha no seek/codec (ex: AV1)
                raw = _extract_frame_ffmpeg(source, timestamp, ffmpeg=ffmpeg)
            scanned += 1
            if raw is None:
                continue
            frame = treatment.apply(raw)
            if fallback_frame is None:
                fallback_frame = frame.copy()
                fallback_meta = {"timestamp": timestamp, "source_size": [raw.shape[1], raw.shape[0]],
                                 "treated_size": [frame.shape[1], frame.shape[0]]}
            if detector is None:
                detector = _make_detector(frame.shape[1], frame.shape[0], work_dir)
            small = cv2.resize(frame, (96, 54))
            if (previous_timestamp is None or timestamp-previous_timestamp > .25
                    or previous_small is not None and float(cv2.absdiff(previous_small, small).mean()) > 35):
                previous_mouths, previous_foreheads = [], []
            previous_timestamp, previous_small = timestamp, small
            faces, current_mouths, current_foreheads = [], [], []
            for found in detector(frame):
                quality = _quality(frame, found)
                if quality is None:
                    continue
                metrics, mouth, forehead = _measure_activity(frame, quality, previous_mouths, previous_foreheads)
                quality.update(metrics)
                quality["visual_score"] = quality["score"]
                quality["score"] = (10*int(quality["mouth_activity"] >= .12)
                                    + 3*int(quality["eye_detail"] >= .65)
                                    + quality["mouth_activity"] + quality["visual_score"])
                faces.append(quality)
                if mouth is not None:
                    current_mouths.append(mouth)
                if forehead is not None:
                    current_foreheads.append(forehead)
            previous_mouths, previous_foreheads = current_mouths, current_foreheads
            if not faces:
                continue
            usable += 1
            faces.sort(key=lambda face: (-face["score"], face["box"][0]))
            base_record = {"timestamp": timestamp, "source_size": [raw.shape[1], raw.shape[0]],
                           "treated_size": [frame.shape[1], frame.shape[0]]}
            choices = [(face["score"], [face]) for face in faces]
            copied = None
            for native_aspect in ("9:16", "16:9"):
                for identifier in TEMPLATE_IDS:
                    preset = PRESETS[native_aspect][identifier]
                    valid = next(((score, group) for score, group in choices
                                  if _layout_possible((frame.shape[1], frame.shape[0]), group, preset)), None)
                    if valid is None:
                        continue
                    score, group = valid
                    key = (native_aspect, identifier)
                    if key not in best or score > best[key][0]["score"]:
                        if copied is None:
                            copied = frame.copy()
                        best[key] = ({**base_record, "faces": group, "score": score}, copied)
    finally:
        cap.release()

    if fallback_frame is None and ranges:
        raw_first = _extract_frame_ffmpeg(source, ranges[0][0], ffmpeg=ffmpeg)
        if raw_first is not None:
            fallback_frame = treatment.apply(raw_first)
            fallback_meta = {"timestamp": ranges[0][0], "source_size": [raw_first.shape[1], raw_first.shape[0]],
                             "treated_size": [fallback_frame.shape[1], fallback_frame.shape[0]]}

    if use_cache and (best or fallback_frame is not None):
        _FRAME_SELECTION_CACHE.clear()
        _FRAME_SELECTION_CACHE[scan_key] = (best, scanned, usable, fallback_frame, fallback_meta)
    return _selected_photo(best, scanned, usable, aspect, template_id, cv2,
                           fallback_frame=fallback_frame, fallback_meta=fallback_meta)


def _selected_photo(best, scanned, usable, aspect, template_id, cv2, fallback_frame=None, fallback_meta=None):
    picked = best.get((aspect, template_id))
    if picked is None and best:
        picked = next((val for key, val in best.items() if key[0] == aspect), None)
        if picked is None:
            picked = next(iter(best.values()), None)
    if picked is None:
        if fallback_frame is None:
            raise CoverError("cover: não foi possível extrair nenhum frame real dos trechos originais com OpenCV ou FFmpeg.")
        print("[Aviso cover] Nenhum rosto utilizável detectado nos trechos originais. Preservando o frame completo da cena.", flush=True)
        fh, fw = fallback_frame.shape[:2]
        meta = fallback_meta or {"timestamp": 0.0, "source_size": [fw, fh], "treated_size": [fw, fh]}
        selection = {
            **meta, "faces": [], "score": 0.0, "framing": "scene",
            "fallback_reason": "no_usable_face_detected_using_scene_frame"
        }
        picked = (selection, fallback_frame)

    selection, frame = picked
    selection = {**selection, "sample_count": scanned, "usable_frames": usable,
                 "selection_policy": "active_speaker_then_eye_detail_and_visual_quality",
                 "sampling": "bounded_temporal_triplets",
                 "active_speaker": any(face.get("mouth_activity", 0) >= .12 for face in selection.get("faces", []))}
    return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), selection


def _font(size, credit=False):
    path = CREDIT_FONT if credit else TITLE_FONT
    if not path.is_file():
        raise CoverError(f"cover: fonte portátil ausente: {path.name}.")
    return ImageFont.truetype(str(path), size)


def _line_options(text, max_lines):
    yield [text]
    if max_lines > 1:
        words = text.split()
        for index in range(1, len(words)):
            yield [" ".join(words[:index]), " ".join(words[index:])]


def _fit_title(text, preset):
    box = preset["title"]["box"]
    width, height = box[2]-box[0], box[3]-box[1]
    draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    for size in range(preset["title"]["size"], preset["title"]["min"]-1, -1):
        font = _font(size)
        options = []
        for lines in _line_options(text, preset["title"]["lines"]):
            widths = [draw.textlength(line, font=font) for line in lines]
            line_height = size
            gap = round(size*.22)
            if max(widths) <= width-4 and len(lines)*line_height+(len(lines)-1)*gap <= height:
                # Natural two-line balance without splitting words or shrinking below the floor.
                imbalance = abs(widths[0]-widths[-1]) if len(lines) == 2 else width
                options.append((max(widths), imbalance, lines))
        if options:
            if preset["title"]["lines"] > 1 and len(text.split()) >= 4:
                two = [option for option in options if len(option[2]) == 2]
                options = two or options
            chosen = min(options, key=lambda option: (option[1], option[0]))
            return {"font_size": size, "lines": chosen[2], "line_count": len(chosen[2]), "box": box}
    raise CoverError("cover.title: título não cabe com legibilidade mínima; reduza o título da capa.")


def _gradient(canvas, axis, begin, end, opacity):
    width, height = canvas.size
    count = height if axis == "y" else width
    ramp = (np.clip((np.arange(count, dtype=float)-begin)/max(1, end-begin), 0, 1)*opacity*255).astype("uint8")
    alpha = np.repeat(ramp[:, None], width, axis=1) if axis == "y" else np.repeat(ramp[None, :], height, axis=0)
    layer = Image.new("RGBA", canvas.size, (*PRESETS["colors"]["ink"], 0))
    layer.putalpha(Image.fromarray(alpha))
    canvas.alpha_composite(layer)


def _face_crop(source_size, face, destination, fraction, center):
    """Fit a whole face with forehead/chin margin at the preset's visual anchor."""
    width, height = source_size
    dx, dy, dr, db = destination
    ratio = (dr-dx)/(db-dy)
    x, y, fw, fh = face["box"]
    min_h = max(fh*1.42, fw*1.30/ratio)
    max_h = min(height, width/ratio)
    if min_h > max_h+1:
        min_h = max_h
    crop_h = min(max_h, max(min_h, fh/fraction))
    crop_w = crop_h*ratio
    cx, cy = x+fw/2, y+fh/2
    left = max(0, min(width-crop_w, cx-center[0]*crop_w))
    top = max(0, min(height-crop_h, cy-center[1]*crop_h))
    # Keep the anatomical box and available forehead/chin margins inside the crop.
    required_top, required_bottom = max(0, y-fh*.20), min(height, y+fh*1.12)
    top = max(0, min(top, required_top))
    if top+crop_h < required_bottom:
        top = max(0, min(height-crop_h, required_bottom-crop_h))
    if left > x-fw*.10:
        left = max(0, x-fw*.10)
    if left+crop_w < x+fw*1.10:
        left = min(width-crop_w, x+fw*1.10-crop_w)
    crop = [round(left, 4), round(top, 4), round(left+crop_w, 4), round(top+crop_h, 4)]
    scale = (dr-dx)/crop_w
    projected = [dx+(x-left)*scale, dy+(y-top)*scale, dx+(x+fw-left)*scale, dy+(y+fh-top)*scale]
    return crop, [round(value, 3) for value in projected]


def _photograph(canvas, source, face, preset, destination, close):
    crop, face_box = _face_crop(source.size, face, destination, preset["face_fraction"], preset["face_center"])
    x, y, right, bottom = destination
    width, height = right-x, bottom-y
    patch = source.crop(crop).resize((width, height), Image.Resampling.LANCZOS)
    if close:
        patch = patch.filter(ImageFilter.UnsharpMask(radius=.85, percent=80, threshold=3))
    patch = ImageEnhance.Brightness(patch).enhance(1.035)
    patch = ImageEnhance.Contrast(patch).enhance(1.02).convert("RGBA")
    top, bottom_fade, right_fade, left_fade = preset["fade"]
    ys, xs = np.ones(height), np.ones(width)
    if top:
        ys[:top] = np.linspace(0, 1, top)
    if bottom_fade:
        ys[-bottom_fade:] = np.minimum(ys[-bottom_fade:], np.linspace(1, 0, bottom_fade))
    if right_fade:
        xs[-right_fade:] = np.linspace(1, 0, right_fade)
    if left_fade:
        xs[:left_fade] = np.linspace(0, 1, left_fade)
    patch.putalpha(Image.fromarray((ys[:, None]*xs[None, :]*255).astype("uint8")))
    canvas.alpha_composite(patch, (x, y))
    return {"source_crop": crop, "destination": destination, "face_box": face_box}


def _intersects(left, right):
    return max(left[0], right[0]) < min(left[2], right[2]) and max(left[1], right[1]) < min(left[3], right[3])


def _scene_photograph(canvas, source, destination):
    """Keep every source edge when no reliable facial anchor is available."""
    left, top, right, bottom = destination
    patch = ImageOps.contain(source, (right-left, bottom-top), Image.Resampling.LANCZOS).convert("RGBA")
    x, y = left+(right-left-patch.width)//2, top+(bottom-top-patch.height)//2
    canvas.alpha_composite(patch, (x, y))
    return {"source_crop": [0, 0, source.width, source.height],
            "destination": [x, y, x+patch.width, y+patch.height],
            "panel": destination, "face_box": None}


def _draw_title(canvas, text, preset, fitted):
    draw = ImageDraw.Draw(canvas)
    ink, white, yellow = (tuple(PRESETS["colors"][key]) for key in ("ink", "white", "yellow"))
    font = _font(fitted["font_size"])
    left, top, right, bottom = fitted["box"]
    band = preset["title"].get("band")
    if band:
        draw.rounded_rectangle(band, radius=10, fill=(*ink, 210))
        draw.rounded_rectangle((band[0], band[1]+16, band[0]+4, band[3]-16), radius=2, fill=yellow)
    align = preset["title"]["align"]
    x, anchor = ((left+right)/2, "mt") if align == "center" else (right, "rt") if align == "right" else (left, "lt")
    boxes = []
    for index, line in enumerate(fitted["lines"]):
        y = top+index*round(fitted["font_size"]*1.22)
        color = yellow if index else white
        # The close's last word carries the same accent as its approved reference.
        if band and " " in line:
            before, accent = line.rsplit(" ", 1)
            before += " "
            full_width = draw.textlength(line, font=font)
            start = x-full_width/2 if align == "center" else x
            draw.text((start, y), before, font=font, fill=white, anchor="lt", stroke_width=1, stroke_fill=ink)
            draw.text((start+draw.textlength(before, font=font), y), accent, font=font, fill=yellow,
                      anchor="lt", stroke_width=1, stroke_fill=ink)
        else:
            draw.text((x, y), line, font=font, fill=color, anchor=anchor, stroke_width=1, stroke_fill=ink)
        boxes.append(list(draw.textbbox((x, y), line, font=font, anchor=anchor, stroke_width=1)))
    return {**fitted, "text": text, "drawn_boxes": boxes}


def _draw_badge(canvas, preset, face_boxes, title_box):
    draw, label = ImageDraw.Draw(canvas), "OS4 DE DIREITA"
    x, y, size, alignment = preset["badge"]
    font = _font(size)
    width, height = round(draw.textlength(label, font=font))+38, size+30
    x = x-width//2 if alignment == "center" else x
    candidates = [(x, y)]
    if canvas.width > canvas.height:
        candidates.extend([(72, 62), (canvas.width-width-72, 62), ((canvas.width-width)//2, 62)])
    chosen_candidate = None
    for cx, cy in candidates:
        box = [cx, cy, cx+width, cy+height]
        if not any(_intersects(box, face) for face in face_boxes) and not _intersects(box, title_box):
            chosen_candidate = (cx, cy, box)
            break
    if chosen_candidate is None:
        print("[Aviso cover] Não há área 100% livre para a marca; posicionando na coordenada padrão.", flush=True)
        cx, cy = candidates[0]
        box = [cx, cy, cx+width, cy+height]
    else:
        cx, cy, box = chosen_candidate
    ink, white, yellow = (tuple(PRESETS["colors"][key]) for key in ("ink", "white", "yellow"))
    draw.rounded_rectangle(box, radius=8, fill=(*ink, 225), outline=(*yellow, 220), width=2)
    draw.text((cx+19, cy+15), label, font=font, fill=white, anchor="lt")
    return box


def compose_cover(photo, selection, *, cover, aspect, source_label=""):
    """Compose one native preset from a selected real frame (also useful for QA)."""
    aspect = _aspect(aspect)
    requested = cover.get("template_id")
    cover = normalize_cover(cover, cover.get("title", ""), aspect)
    applied = cover["template_id"]
    reason = ("retired_two_person_template" if requested == RETIRED_PAIR_TEMPLATE
              else selection.get("fallback_reason"))
    scene_fallback = selection.get("framing") == "scene" or not selection.get("faces")
    if scene_fallback:
        applied = default_template(aspect)
        reason = reason or "no_usable_face_detected_using_scene_frame"
    preset = PRESETS[aspect][applied]
    try:
        fitted = _fit_title(cover["title"], preset)
    except CoverError:
        if applied != "03_close":
            raise
        applied, reason = default_template(aspect), "close_title_exceeds_readable_single_line"
        preset = PRESETS[aspect][applied]
        fitted = _fit_title(cover["title"], preset)
    size = tuple(PRESETS[aspect]["size"])
    canvas = ImageOps.fit(photo, size, Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(26)).convert("RGBA")
    canvas = Image.alpha_composite(canvas, Image.new("RGBA", size, (*PRESETS["colors"]["ink"], 95)))
    if scene_fallback:
        crops = [_scene_photograph(canvas, photo, preset["photos"][0])]
    else:
        faces = selection["faces"][:len(preset["photos"])]
        crops = [_photograph(canvas, photo, face, preset, destination, applied == "03_close")
                 for face, destination in zip(faces, preset["photos"])]
    face_boxes = [crop["face_box"] for crop in crops if crop["face_box"] is not None]
    for face_box in face_boxes:
        if _intersects(face_box, fitted["box"]):
            if not reason:
                reason = "face_box_overlaps_title_zone"
            print("[Aviso cover] Enquadramento do rosto cruza área do título; mantendo composição com aviso.", flush=True)
    for gradient in preset["gradients"]:
        _gradient(canvas, *gradient)
    draw = ImageDraw.Draw(canvas)
    if "line" in preset:
        *points, width = preset["line"]
        draw.line(points, fill=tuple(PRESETS["colors"]["yellow"]), width=width)
    typography = _draw_title(canvas, cover["title"], preset, fitted)
    badge = _draw_badge(canvas, preset, face_boxes, fitted["box"])
    if aspect == "9:16":
        draw.text((62, 1825), "@os4dedireita", font=_font(22, credit=True), fill=(220, 221, 224), anchor="lt")
        if source_label:
            draw.text((1018, 1825), _credit_text(source_label, 500, 21), font=_font(21, credit=True),
                      fill=(198, 201, 207), anchor="rt")
    elif source_label:
        text = _credit_text(source_label, 600, 23)
        credit_box = draw.textbbox((1846, 72), text, font=_font(23, credit=True), anchor="rt")
        if not any(_intersects(credit_box, face) for face in face_boxes):
            draw.text((1846, 72), text, font=_font(23, credit=True), fill=(233, 234, 237), anchor="rt",
                      stroke_width=1, stroke_fill=tuple(PRESETS["colors"]["ink"]))
    return canvas.convert("RGB"), {"requested_template": requested, "applied_template": applied,
                                    "fallback_reason": reason, "framing": "scene" if scene_fallback else "face",
                                    "typography": typography,
                                    "crops": crops, "badge_box": badge, "size": list(size)}


def _credit_text(label, width, size):
    text = "Fonte: " + " ".join(str(label).split())
    draw, font = ImageDraw.Draw(Image.new("RGB", (1, 1))), _font(size, credit=True)
    while len(text) > 8 and draw.textlength(text, font=font) > width:
        text = text[:-2].rstrip() + "…"
    return text


def render_cover(source_video, ranges, output, *, cover=None, title="", aspect="9:16", lower_third=None,
                 work_dir=None, ffmpeg="ffmpeg", ffprobe=None, detector=None,
                 max_candidates=MAX_CANDIDATES, source_label=""):
    """Render/cache a mandatory cover before synthesis or final video delivery.

    ffmpeg/ffprobe are accepted alongside renderer configuration; frame decoding
    uses the same OpenCV stack as tracking. The cache records source bytes,
    presets/fonts, range/treatment, title and requested model independently of
    narration and video. Injected detectors deliberately bypass persistent cache.
    """
    del ffprobe
    source, output = Path(source_video), Path(output)
    if not source.is_file():
        raise CoverError("cover: vídeo original não encontrado.")
    aspect, treatment = _aspect(aspect), _lower_third(lower_third)
    config, intervals = normalize_cover(cover, title, aspect), _ranges(ranges)
    # Title and packaged font failures are caught before scanning media or any paid voice operation.
    candidate = PRESETS[aspect][config["template_id"]]
    effective_template = config["template_id"]
    try:
        _fit_title(config["title"], candidate)
    except CoverError:
        if config["template_id"] != "03_close":
            raise
        _fit_title(config["title"], PRESETS[aspect][default_template(aspect)])
        effective_template = default_template(aspect)
    for font_path in (TITLE_FONT, CREDIT_FONT):
        _font(24, credit=font_path == CREDIT_FONT)
    work = Path(work_dir) if work_dir else output.parent / ".cover-cache"
    work.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    cache_key = _canonical_hash({"version": COVER_VERSION, "source_sha256": _file_hash(source),
                                 "ranges": intervals, "aspect": aspect, "cover": config,
                                 "requested_template": (cover or config)["template_id"],
                                 "lower_third": vars(treatment), "presets": _file_hash(PRESET_FILE),
                                 "fonts": [_file_hash(TITLE_FONT), _file_hash(CREDIT_FONT)],
                                 "compositor_sha256": _file_hash(__file__),
                                 "max_candidates": max_candidates, "source_label": source_label})
    cached_image, cached_report = work/f"{cache_key}.jpg", work/f"{cache_key}.json"
    if detector is None and cached_image.is_file() and cached_report.is_file():
        try:
            report = json.loads(cached_report.read_text(encoding="utf-8"))
            if report["sha256"] == _file_hash(cached_image):
                if cached_image.resolve() != output.resolve():
                    shutil.copyfile(cached_image, output)
                return {**report, "path": str(output.resolve()), "cache_hit": True}
        except (ValueError, KeyError, OSError):
            pass
    photo, selection = _select_frame(source, intervals, treatment, work, detector=detector,
                                      max_candidates=max_candidates,
                                      aspect=aspect, template_id=effective_template, ffmpeg=ffmpeg)
    # Preserve the originally requested layout in diagnostics while rendering
    # only the migrated single-face configuration. It has its own cache key.
    image, details = compose_cover(photo, selection, cover=cover or config, aspect=aspect, source_label=source_label)
    image.save(cached_image, quality=95, subsampling=0)
    report = {"version": COVER_VERSION, "cover": config, "aspect": aspect, **details,
              "selection": selection, "lower_third": vars(treatment), "cache_key": cache_key,
              "sha256": _file_hash(cached_image), "path": str(output.resolve()), "cache_hit": False}
    cached_report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    if cached_image.resolve() != output.resolve():
        shutil.copyfile(cached_image, output)
    return report
