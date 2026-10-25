"""Temporal timeline engine for OS4 Motion Dark graphics.

Builds narrative-synchronized visual beats aligned with canonical TTS words,
with deterministic proportional fallbacks when literal anchors are not matched.
"""
from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .editorial_paper import _tokens, literal_anchor


SUPPORTED_BEAT_TYPES = (
    "headline",
    "metric",
    "strike_comparison",
    "comparison",
    "quote_card",
    "document_card",
    "source_focus",
)

SUPPORTED_VIDEO_MODES = ("window", "bottom", "hidden", "side")


@dataclass
class MotionBeat:
    id: str
    beat_type: str
    anchor: str
    start_time: float
    end_time: float
    video_mode: str = "window"
    data: Dict[str, Any] = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return max(0.0, self.end_time - self.start_time)


def _find_anchor_time(words: list, anchor_text: str) -> Optional[float]:
    """Find the literal audio timestamp of an anchor phrase in aligned words."""
    if not words or not anchor_text or not isinstance(anchor_text, str):
        return None
    return literal_anchor(words, anchor_text)


def _legacy_beats_from_scene(scene: dict, duration: float, words: list = ()) -> List[MotionBeat]:
    """Preserve 100% backward compatibility for legacy single-layout scenes."""
    visual = scene.get("visual") or {}
    motion = visual.get("motion") or {}
    layout = motion.get("layout", "source_card")
    icon = motion.get("icon", "line-md:chat")
    emphasis = motion.get("emphasis", "")
    title = visual.get("title", "")
    lines = visual.get("lines", [])

    if layout == "comparison" and len(lines) > 1:
        # 2-stage comparison
        half = duration / 2.0
        # Try finding anchor for line 1
        t_split = _find_anchor_time(words, lines[1]) if words else None
        split_time = t_split if (t_split is not None and 0.5 <= t_split <= duration - 0.5) else half
        return [
            MotionBeat(
                id="legacy-comp-0",
                beat_type="comparison",
                anchor=lines[0] if lines else title,
                start_time=0.0,
                end_time=split_time,
                video_mode="hidden",
                data={
                    "stage": 0,
                    "title": title,
                    "emphasis": emphasis,
                    "icon": icon,
                    "left_label": "01 / ANTES",
                    "left_text": lines[0],
                    "right_label": "02 / DEPOIS",
                    "right_text": lines[1],
                    "active_side": "left",
                },
            ),
            MotionBeat(
                id="legacy-comp-1",
                beat_type="comparison",
                anchor=lines[1],
                start_time=split_time,
                end_time=duration,
                video_mode="hidden",
                data={
                    "stage": 1,
                    "title": title,
                    "emphasis": emphasis,
                    "icon": icon,
                    "left_label": "01 / ANTES",
                    "left_text": lines[0],
                    "right_label": "02 / DEPOIS",
                    "right_text": lines[1],
                    "active_side": "right",
                },
            ),
        ]

    if layout == "number":
        content = lines[0] if lines else title
        match = re.search(r"(?<!\w)\d[\d.,%]*", content) or re.search(r"(?<!\w)\d[\d.,%]*", title)
        figure = match.group(0) if match else "0"
        explanation = re.sub(re.escape(figure), "", content, count=1).strip(" :-–—") if match else content
        return [
            MotionBeat(
                id="legacy-num-0",
                beat_type="metric",
                anchor=figure,
                start_time=0.0,
                end_time=duration,
                video_mode="hidden",
                data={
                    "title": title,
                    "value": figure,
                    "label": explanation or title,
                    "emphasis": emphasis,
                    "icon": icon,
                },
            )
        ]

    if layout == "quote":
        content = lines[0] if lines else title
        return [
            MotionBeat(
                id="legacy-quote-0",
                beat_type="quote_card",
                anchor="",
                start_time=0.0,
                end_time=duration,
                video_mode="hidden",
                data={
                    "title": title,
                    "quote": content,
                    "emphasis": emphasis,
                    "icon": icon,
                },
            )
        ]

    if layout == "source_card":
        content = lines[0] if lines else title
        return [
            MotionBeat(
                id="legacy-source-0",
                beat_type="source_focus",
                anchor="",
                start_time=0.0,
                end_time=duration,
                video_mode="window",
                data={
                    "title": title,
                    "label": content,
                    "emphasis": emphasis,
                    "icon": icon,
                },
            )
        ]

    # statement or fallback
    content = lines[0] if lines else title
    return [
        MotionBeat(
            id="legacy-statement-0",
            beat_type="headline",
            anchor="",
            start_time=0.0,
            end_time=duration,
            video_mode="window",
            data={
                "title": title,
                "statement": content,
                "emphasis": emphasis,
                "icon": icon,
            },
        )
    ]


def resolve_scene_timeline(
    scene: dict,
    duration: float,
    words: list = (),
    min_beat_duration: float = 0.8,
) -> List[MotionBeat]:
    """Resolve a list of synchronized MotionBeats for a narration scene.

    If visual.motion.beats is provided, maps each anchor to its real-world audio
    timestamp. If timestamps are unaligned or missing, applies a deterministic
    proportional allocation so rendering never stalls or cuts speech.
    """
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"Duração de cena inválida: {duration}")

    visual = scene.get("visual") or {}
    motion = visual.get("motion") or {}
    raw_beats = motion.get("beats")

    if not raw_beats or not isinstance(raw_beats, list):
        return _legacy_beats_from_scene(scene, duration, words)

    n = len(raw_beats)
    if n == 0:
        return _legacy_beats_from_scene(scene, duration, words)

    # 1. Extract raw candidates and match anchors with audio words
    candidates = []
    for i, raw in enumerate(raw_beats):
        if not isinstance(raw, dict):
            continue
        beat_type = raw.get("type", "headline")
        if beat_type not in SUPPORTED_BEAT_TYPES:
            beat_type = "headline"
        anchor = str(raw.get("anchor", "")).strip()
        video_mode = raw.get("video_mode", "hidden")
        if video_mode not in SUPPORTED_VIDEO_MODES:
            video_mode = "hidden"

        matched_t = _find_anchor_time(words, anchor) if anchor else None
        candidates.append({
            "index": i,
            "raw": raw,
            "beat_type": beat_type,
            "anchor": anchor,
            "matched_t": matched_t,
            "video_mode": video_mode,
        })

    if not candidates:
        return _legacy_beats_from_scene(scene, duration, words)

    total_beats = len(candidates)
    
    # 2. Assign monotonic timestamps with deterministic fallback
    # If a beat has a matched anchor, we try to use it as long as order is preserved
    # and min_beat_duration is respected.
    start_times = [0.0] * total_beats
    start_times[0] = 0.0

    proportional_step = duration / total_beats

    for i in range(1, total_beats):
        c = candidates[i]
        ideal_min = start_times[i - 1] + min_beat_duration
        max_possible = duration - (total_beats - 1 - i) * min_beat_duration

        if c["matched_t"] is not None and ideal_min <= c["matched_t"] <= max_possible:
            start_times[i] = c["matched_t"]
        else:
            # Fallback to smooth proportional pacing
            fallback_t = i * proportional_step
            start_times[i] = max(ideal_min, min(fallback_t, max_possible))

    # 3. Build MotionBeat instances with strictly non-overlapping intervals
    beats: List[MotionBeat] = []
    for i in range(total_beats):
        c = candidates[i]
        s_time = start_times[i]
        e_time = start_times[i + 1] if i + 1 < total_beats else duration

        # Clean payload data
        data = dict(c["raw"])
        data.pop("type", None)
        data.pop("anchor", None)
        data.pop("video_mode", None)
        
        # Merge global visual title/emphasis if not present in beat data
        if "title" not in data and visual.get("title"):
            data["title"] = visual.get("title")
        if "emphasis" not in data and motion.get("emphasis"):
            data["emphasis"] = motion.get("emphasis")
        if "icon" not in data and motion.get("icon"):
            data["icon"] = motion.get("icon")

        beats.append(
            MotionBeat(
                id=f"beat-{i:02d}-{c['beat_type']}",
                beat_type=c["beat_type"],
                anchor=c["anchor"],
                start_time=s_time,
                end_time=e_time,
                video_mode=c["video_mode"],
                data=data,
            )
        )

    return beats
