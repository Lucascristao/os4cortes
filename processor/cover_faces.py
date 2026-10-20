"""Additional face confirmation for covers that promise two real people.

The regular selection remains permissive for single-person covers. A pair uses
another view of each candidate through the existing detector, so a small pattern
that resembles a face at the source scale cannot immediately become a portrait.
This is geometric confirmation, not identity recognition or a liveness model.
"""
from __future__ import annotations

import math

import numpy as np


def _box(face):
    try:
        values = tuple(float(value) for value in face["box"])
    except (KeyError, TypeError, ValueError):
        return None
    if len(values) != 4 or not all(math.isfinite(value) for value in values):
        return None
    return values if values[2] > 0 and values[3] > 0 else None


def _plausible_landmarks(face):
    """Reject degenerate landmarks while allowing profiles and tilted faces."""
    box = _box(face)
    if box is None:
        return False
    try:
        points = np.asarray(face["landmarks"], dtype=float)
    except (KeyError, TypeError, ValueError):
        return False
    if points.shape != (5, 2) or not np.isfinite(points).all():
        return False
    x, y, width, height = box
    if ((points[:, 0] < x-width*.15).any() or (points[:, 0] > x+width*1.15).any()
            or (points[:, 1] < y-height*.15).any() or (points[:, 1] > y+height*1.15).any()):
        return False
    eye_vector = points[1]-points[0]
    eye_distance = float(np.linalg.norm(eye_vector))
    if not width*.08 <= eye_distance <= width*1.05:
        return False
    # Use the eye axis, rather than fixed horizontal coordinates, for head tilt.
    down = np.array([-eye_vector[1], eye_vector[0]]) / eye_distance
    if down[1] < 0:
        down = -down
    eyes = (points[0]+points[1])/2
    mouth = (points[3]+points[4])/2
    nose_depth = float(np.dot(points[2]-eyes, down)) / height
    mouth_depth = float(np.dot(mouth-eyes, down)) / height
    mouth_width = float(np.linalg.norm(points[4]-points[3])) / width
    return (-.08 <= nose_depth <= .60 and .08 <= mouth_depth <= .85
            and nose_depth <= mouth_depth+.08 and .04 <= mouth_width <= 1.05)


def _confirmation_crop(frame, box):
    """Keep the source aspect so its existing detector never stretches a crop."""
    height, width = frame.shape[:2]
    x, y, face_width, face_height = box
    ratio = width/height
    crop_height = max(32, math.ceil(max(face_height, face_width/ratio)*1.65))
    crop_width = max(32, round(crop_height*ratio))
    left = math.floor(x+face_width/2-crop_width/2)
    top = math.floor(y+face_height/2-crop_height/2)
    right, bottom = left+crop_width, top+crop_height
    source_left, source_top = max(0, left), max(0, top)
    source_right, source_bottom = min(width, right), min(height, bottom)
    if source_right <= source_left or source_bottom <= source_top:
        return None
    region = frame[source_top:source_bottom, source_left:source_right]
    # Repeating an edge avoids inventing facial detail when the context extends
    # outside the source. Padding also preserves the exact translation below.
    padding = ((source_top-top, bottom-source_bottom),
               (source_left-left, right-source_right))
    if region.ndim == 3:
        padding += ((0, 0),)
    crop = np.pad(region, padding, mode="edge")
    return crop, left, top


def _same_candidate(original, confirmed):
    ax, ay, aw, ah = original
    bx, by, bw, bh = confirmed
    intersection = max(0, min(ax+aw, bx+bw)-max(ax, bx)) * max(0, min(ay+ah, by+bh)-max(ay, by))
    union = aw*ah+bw*bh-intersection
    # Do not let a nearby real face confirm the false candidate being checked.
    center_distance = math.hypot((ax+aw/2)-(bx+bw/2), (ay+ah/2)-(by+bh/2))
    return (intersection/max(1, union) >= .35 and center_distance <= max(aw, ah)*.35
            and .45 <= bw/aw <= 1.8 and .45 <= bh/ah <= 1.8)


def confirm_pair_faces(frame, faces, detector):
    """Return copies of face records confirmed in a larger independent crop.

    ``detector`` is the same callable used to scan full frames and must return
    source-coordinate boxes and YuNet's five landmarks. No detector/model is
    created here. Failure to confirm only removes a candidate from pair layouts;
    callers retain their original list for the permissive single-face fallback.
    """
    confirmed = []
    for face in faces:
        box = _box(face)
        if box is None or ("landmarks" in face and not _plausible_landmarks(face)):
            continue
        view = _confirmation_crop(frame, box)
        if view is None:
            continue
        crop, left, top = view
        try:
            detections = detector(crop) or []
        except Exception:
            # This optional quality pass must not turn a usable single cover
            # into a failed cut. The normal detector failures remain visible.
            continue
        for detection in detections:
            detected_box = _box(detection)
            if detected_box is None or not _plausible_landmarks(detection):
                continue
            x, y, width, height = detected_box
            if _same_candidate(box, (x+left, y+top, width, height)):
                confirmed.append({**face, "pair_verified": True,
                                  "pair_confirmation": {
                                      "method": "source_aspect_context_crop_redetection",
                                      "confidence": round(float(detection.get("confidence", 0)), 6),
                                      "source_box": [round(value, 4) for value in
                                                     (x+left, y+top, width, height)],
                                      "context_crop": [left, top, left+crop.shape[1], top+crop.shape[0]],
                                  }})
                break
    return confirmed
