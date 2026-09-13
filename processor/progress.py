from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.request
from typing import Any


def _callback_token(request_id: str) -> str:
    explicit = os.getenv("OS4_CALLBACK_TOKEN", "").strip()
    if explicit:
        return explicit

    shared_secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    if not shared_secret or not request_id:
        return ""

    return hmac.new(
        shared_secret.encode("utf-8"),
        f"os4-progress:{request_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _post(payload: dict[str, Any]) -> None:
    url = os.getenv("OS4_PROGRESS_URL", "").strip()
    request_id = os.getenv("OS4_REQUEST_ID", "").strip()
    token = _callback_token(request_id)

    if not (url and token and request_id):
        return

    body = {
        "request_id": request_id,
        "token": token,
        **payload,
    }
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")

    for attempt in range(3):
        try:
            req = urllib.request.Request(
                url,
                data=data,
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=8) as response:
                response.read()
            return
        except Exception as exc:
            if attempt == 2:
                print(f"OS4_PROGRESS_CALLBACK_WARNING|{type(exc).__name__}: {exc}", flush=True)
            else:
                time.sleep(0.8 * (attempt + 1))


def emit(
    stage: str,
    overall: float,
    detail: str = "",
    *,
    stage_percent: float | None = None,
    current: float | None = None,
    total: float | None = None,
    cut: int | None = None,
    total_cuts: int | None = None,
    status: str = "running",
    result: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    parts = [
        "OS4_PROGRESS",
        f"stage={stage}",
        f"overall={float(overall):.1f}",
    ]
    if stage_percent is not None:
        parts.append(f"stage_percent={float(stage_percent):.1f}")
    if current is not None:
        parts.append(f"current={float(current):.1f}")
    if total is not None:
        parts.append(f"total={float(total):.1f}")
    if cut is not None:
        parts.append(f"cut={int(cut)}")
    if total_cuts is not None:
        parts.append(f"total_cuts={int(total_cuts)}")
    if detail:
        parts.append(f"detail={detail.replace('|', '/')}"[:600])

    print("|".join(parts), flush=True)

    payload: dict[str, Any] = {
        "status": status,
        "stage": stage,
        "percent": max(0.0, min(100.0, float(overall))),
        "detail": detail,
    }
    if stage_percent is not None:
        payload["stage_percent"] = max(0.0, min(100.0, float(stage_percent)))
    if current is not None:
        payload["current"] = float(current)
    if total is not None:
        payload["total"] = float(total)
    if cut is not None:
        payload["cut"] = int(cut)
    if total_cuts is not None:
        payload["total_cuts"] = int(total_cuts)
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = str(error)

    _post(payload)


def completed(detail: str, result: dict[str, Any]) -> None:
    emit("concluido", 100.0, detail, status="completed", result=result)


def failed(detail: str, error: str | None = None) -> None:
    emit("erro", 100.0, detail, status="error", error=error or detail)
