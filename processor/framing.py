"""Temporal framing policy. Coordinates are normalized, timings are in seconds.

Face continuity is not speaker recognition: a reaction must not automatically
pull the camera away from the current subject.
"""
from __future__ import annotations

from dataclasses import dataclass
import math


@dataclass(frozen=True)
class Face:
    x: float
    y: float
    width: float
    height: float
    confidence: float = 1.0
    speaking_score: float = 0.0

    @property
    def center(self) -> float:
        return self.x + self.width / 2

    @property
    def area(self) -> float:
        return self.width * self.height

    @property
    def priority(self) -> float:
        """Prioridade baseada em tamanho, confiança e movimento labial de fala."""
        return (self.area * self.confidence) * (1.0 + 2.5 * self.speaking_score)


def same_face(a: Face, b: Face) -> bool:
    """Associate nearby detections; never match the other side of a wide shot."""
    distance = math.hypot(
        a.center - b.center,
        (a.y + a.height / 2) - (b.y + b.height / 2),
    )
    size_ratio = b.area / max(a.area, 1e-9)
    return (
        distance < max(0.055, min(0.16, max(a.width, b.width) * 0.8))
        and 0.35 < size_ratio < 2.8
    )


class StableFraming:
    def __init__(
        self,
        crop_fraction: float,
        lost_hold: float = 0.9,
        switch_hold: float = 0.50,
    ):
        self.crop_fraction = min(1.0, max(0.05, float(crop_fraction)))
        self.lost_hold = float(lost_hold)
        self.switch_hold = float(switch_hold)
        self.center = 0.5
        self.target: Face | None = None
        self.last_seen = -math.inf
        self.candidate: Face | None = None
        self.candidate_since = 0.0
        self.candidate_last_valid = 0.0
        self.last_time: float | None = None
        self.fresh_shot = True

    def reset_shot(self, snap: bool = True):
        self.target = None
        self.candidate = None
        self.candidate_since = 0.0
        self.candidate_last_valid = 0.0
        self.fresh_shot = snap

    def observe(self, faces: list[Face], timestamp: float):
        faces = [
            f
            for f in faces
            if f.width > 0 and f.height > 0 and f.confidence >= 0.70
        ]

        if self.target is not None:
            matches = [f for f in faces if same_face(self.target, f)]
            if matches:
                self.target = min(
                    matches, key=lambda f: abs(f.center - self.target.center)
                )
                self.last_seen = timestamp

                # Se o target atual NÃO está falando ativamente, verificar se outro rosto está
                others = [f for f in faces if not same_face(self.target, f)]
                best_other = max(others, key=lambda f: f.speaking_score, default=None) if others else None
                
                is_other_speaking = (
                    best_other is not None
                    and best_other.speaking_score > 0.30
                    and best_other.speaking_score > self.target.speaking_score + 0.15
                )

                if is_other_speaking:
                    if self.candidate is not None and same_face(self.candidate, best_other):
                        self.candidate = best_other
                        self.candidate_last_valid = timestamp
                        if timestamp - self.candidate_since >= self.switch_hold:
                            self.target = best_other
                            self.last_seen = timestamp
                            self.candidate = None
                    else:
                        self.candidate = best_other
                        self.candidate_since = timestamp
                        self.candidate_last_valid = timestamp
                else:
                    # Tolerância para pausas naturais entre palavras/sílabas (até 0.30s de silêncio)
                    if self.candidate is not None and (timestamp - self.candidate_last_valid > 0.30):
                        self.candidate = None
                return

            if timestamp - self.last_seen < self.lost_hold:
                return

        if not faces:
            self.candidate = None
            return  # Hold the last useful frame during missed detections.

        best = max(faces, key=lambda f: f.priority)

        # Se não há target ativo, assume o melhor rosto imediatamente (elimina pausa no vazio)
        if self.target is None:
            self.target = best
            self.last_seen = timestamp
            if self.fresh_shot:
                self.center = self._clamp(best.center)
                self.fresh_shot = False
            return

        if self.candidate is None or not same_face(self.candidate, best):
            self.candidate = best
            self.candidate_since = timestamp
            return

        self.candidate = best
        if timestamp - self.candidate_since >= self.switch_hold:
            self.target = best
            self.last_seen = timestamp
            self.candidate = None

    def _clamp(self, center: float) -> float:
        half = self.crop_fraction / 2
        return max(half, min(1.0 - half, center))

    def position(self, timestamp: float) -> float:
        dt = 0.0 if self.last_time is None else max(0.0, timestamp - self.last_time)
        self.last_time = timestamp

        if self.target is None:
            return self.center

        destination = self._clamp(self.target.center)
        error = destination - self.center
        deadband = self.crop_fraction * 0.055

        if abs(error) > deadband:
            # Transição rápida e dinâmica sem paradas ou arrastos lentos
            movement = (error - math.copysign(deadband, error)) * (
                1.0 - math.exp(-dt / 0.10)
            )
            limit = 1.80 * dt
            self.center = self._clamp(
                self.center + max(-limit, min(limit, movement))
            )

        return self.center
