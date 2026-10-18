"""Validated editorial plans: the package owns the script; rendering owns timing."""
from __future__ import annotations

import hashlib
import json
import math
import re


def _text(value, name, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name}: texto obrigatório, até {maximum} caracteres.")
    return value.strip()


def _range(raw, name, lower, upper):
    if not isinstance(raw, dict):
        raise ValueError(f"{name}: informe start/end em segundos.")
    values = []
    for key in ("start", "end"):
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name}.{key}: tempo numérico finito obrigatório.")
        values.append(float(value))
    start, end = values
    if start < 0 or end <= start or (lower is not None and start < lower - .001) or (upper is not None and end > upper + .001):
        raise ValueError(f"{name}: intervalo fora do corte selecionado ou inválido.")
    return {"start": start, "end": end}


def normalize_editorial_plan(raw, *, clip_start=None, clip_end=None):
    if not isinstance(raw, dict) or type(raw.get("version")) is not int or raw["version"] != 1:
        raise ValueError("editorial: objeto com version: 1 obrigatório.")
    source = raw.get("source", {})
    if not isinstance(source, dict):
        raise ValueError("editorial.source precisa ser um objeto.")
    label = _text(source.get("label", "Fonte original"), "editorial.source.label", 120)
    date = str(source.get("date", ""))
    if date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("editorial.source.date deve usar AAAA-MM-DD.")
    scenes = raw.get("scenes")
    if not isinstance(scenes, list) or not 2 <= len(scenes) <= 12:
        raise ValueError("editorial.scenes deve conter de 2 a 12 cenas.")
    result = {"version": 1, "source": {"label": label, "date": date}, "scenes": []}
    identifiers = set()
    for index, scene in enumerate(scenes):
        name = f"editorial.scenes[{index}]"
        if not isinstance(scene, dict):
            raise ValueError(f"{name}: objeto obrigatório.")
        identifier = scene.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}", identifier) or identifier in identifiers:
            raise ValueError(f"{name}.id: identificador único e seguro obrigatório.")
        identifiers.add(identifier)
        kind = scene.get("kind")
        normalized = {"id": identifier, "kind": kind}
        if kind == "clip":
            normalized.update(_range(scene, name, clip_start, clip_end))
        elif kind == "narration":
            text = _text(scene.get("text"), f"{name}.text", 1400)
            normalized["text"] = text
            normalized["background"] = _range(scene.get("background"), f"{name}.background", clip_start, clip_end)
            visual = scene.get("visual", {})
            if not isinstance(visual, dict):
                raise ValueError(f"{name}.visual: objeto obrigatório.")
            lines = visual.get("lines", [])
            if not isinstance(lines, list) or len(lines) > 3:
                raise ValueError(f"{name}.visual.lines: até três linhas.")
            normalized["visual"] = {
                "title": _text(visual.get("title"), f"{name}.visual.title", 100),
                "kicker": str(visual.get("kicker", ""))[:60],
                "lines": [_text(line, f"{name}.visual.lines", 140) for line in lines],
            }
            tts = scene.get("tts", {"delivery": "explain"})
            if not isinstance(tts, dict) or tts.get("delivery", "explain") not in ("hook", "explain", "contrast", "question", "closing"):
                raise ValueError(f"{name}.tts: direção vocal inválida.")
            cues = tts.get("cues", [])
            if not isinstance(cues, list) or len(cues) > 6:
                raise ValueError(f"{name}.tts.cues: até seis indicações vocais.")
            for cue in cues:
                if not isinstance(cue, dict) or not isinstance(cue.get("text"), str) or not cue["text"] or text.count(cue["text"]) != 1:
                    raise ValueError(f"{name}.tts.cues: cada indicação deve citar um trecho literal único.")
            normalized["tts"] = json.loads(json.dumps(tts, ensure_ascii=False, allow_nan=False))
            evidence = scene.get("evidence")
            if not isinstance(evidence, list) or not 1 <= len(evidence) <= 8:
                raise ValueError(f"{name}.evidence: ancore a narração em pelo menos um trecho da fonte.")
            normalized["evidence"] = [_range(item, f"{name}.evidence", clip_start, clip_end) for item in evidence]
        else:
            raise ValueError(f"{name}.kind precisa ser clip ou narration.")
        result["scenes"].append(normalized)
    kinds = {scene["kind"] for scene in result["scenes"]}
    if kinds != {"clip", "narration"}:
        raise ValueError("editorial: combine comentário autoral e pelo menos um trecho original.")
    return result


def validate_source_ranges(plan, words):
    """Reject empty/out-of-source references; this is not a semantic fact check."""
    if not words:
        raise ValueError("O plano narrado exige transcrição da fonte.")
    source_end = max(float(word["fim"]) for word in words)
    for scene in plan["scenes"]:
        ranges = [scene] if scene["kind"] == "clip" else [scene["background"], *scene["evidence"]]
        for span in ranges:
            if span["end"] > source_end + .25 or not any(float(word["inicio"]) < span["end"] and float(word["fim"]) > span["start"] for word in words):
                raise ValueError(f"Cena {scene['id']}: referência sem fala ou fora da transcrição.")


def editorial_fingerprint(plan):
    return hashlib.sha256(json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
