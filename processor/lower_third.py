"""Treatment of a lower third in source coordinates, before reframing."""
from __future__ import annotations

from dataclasses import dataclass
import math
from numbers import Integral, Real


def _positive_dimension(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral) or value <= 0:
        raise ValueError(f"{name} must be a positive integer.")
    return int(value)


@dataclass(frozen=True)
class LowerThird:
    mode: str = "off"
    height_fraction: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.mode, str) or self.mode not in ("off", "cover", "crop"):
            raise ValueError("Lower-third mode must be off, cover or crop.")
        fraction = self.height_fraction
        if (
            isinstance(fraction, bool)
            or not isinstance(fraction, Real)
            or not math.isfinite(fraction)
            or not 0.0 <= fraction <= 0.60
        ):
            raise ValueError("Lower-third height_fraction must be a finite number from 0 to 0.60.")
        if self.mode != "off" and fraction <= 0:
            raise ValueError("An active lower-third treatment requires a positive height_fraction.")

    def content_height(self, source_h: int) -> int:
        """Return the rows above the band, rounding its height up for full coverage."""
        source_h = _positive_dimension(source_h, "source_h")
        if self.mode == "off":
            return source_h
        return source_h - math.ceil(source_h * self.height_fraction)

    def apply(self, frame):
        """Keep the original, mask a copy, or return a view above the source band."""
        if self.mode == "off":
            return frame
        content_h = self.content_height(frame.shape[0])
        if self.mode == "cover":
            covered = frame.copy()
            covered[content_h:] = 0
            return covered
        return frame[:content_h]


def fit_crop_size(width: int, height: int, aspect: float) -> tuple[int, int]:
    """Fit the largest target-aspect rectangle, allowing integer-pixel rounding.

    The limiting dimension stays whole. The other is rounded to its nearest
    pixel and clamped to the available bounds; even tiny frames stay nonempty.
    """
    width = _positive_dimension(width, "width")
    height = _positive_dimension(height, "height")
    if (
        isinstance(aspect, bool)
        or not isinstance(aspect, Real)
        or not math.isfinite(aspect)
        or aspect <= 0
    ):
        raise ValueError("aspect must be a positive finite number.")

    if width / height >= aspect:
        return max(1, min(width, round(height * aspect))), height
    return width, max(1, min(height, round(width / aspect)))
