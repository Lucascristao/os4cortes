"""Validated editorial plans: the package owns the script; rendering owns timing."""
from __future__ import annotations

import hashlib
import json
import math
import re


EDITORIAL_TOPICS = ("politics", "economy", "business", "humor", "general")
EDITORIAL_TONES = ("conversational", "provocative", "ironic", "playful", "explanatory", "serious")
EDITORIAL_INTENSITIES = ("low", "medium", "high")
EDITORIAL_COMMENTARY_MODES = ("support_source", "challenge_source", "direct_commentary")
EDITORIAL_VISUAL_STYLES = ("classic", "paper", "motion_dark")
DEFAULT_EDITORIAL_INTENT = {
    "mode": "direct_commentary", "source_point": "", "target": "", "contribution": "",
}
DEFAULT_EDITORIAL_PROFILE = {
    "perspective": "right", "topic": "general", "tone": "conversational",
    "intensity": "medium", "angle": "", "audience_question": "",
}


def _choice(value, name, choices):
    if not isinstance(value, str) or value not in choices:
        raise ValueError(f"{name}: use {', '.join(choices)}.")
    return value


def _editorial_profile(raw):
    if not isinstance(raw, dict):
        raise ValueError("editorial.profile: objeto obrigatório.")
    if set(raw) - set(DEFAULT_EDITORIAL_PROFILE):
        raise ValueError("editorial.profile: campo desconhecido.")
    question = raw.get("audience_question")
    if not isinstance(question, str) or len(question) > 240:
        raise ValueError("editorial.profile.audience_question: texto de até 240 caracteres.")
    return {
        "perspective": _choice(raw.get("perspective"), "editorial.profile.perspective", ("right",)),
        "topic": _choice(raw.get("topic"), "editorial.profile.topic", EDITORIAL_TOPICS),
        "tone": _choice(raw.get("tone"), "editorial.profile.tone", EDITORIAL_TONES),
        "intensity": _choice(raw.get("intensity"), "editorial.profile.intensity", EDITORIAL_INTENSITIES),
        "angle": _text(raw.get("angle"), "editorial.profile.angle", 240),
        "audience_question": question.strip(),
    }


def effective_editorial_profile(plan, scene=None):
    """Resolve interpretation without adding metadata to legacy packages.

    Free-form angle/question describe the script; only validated enum fields may
    be translated into fixed voice instructions. Scene overrides affect acting,
    never the narrator's identity or the literal narration.
    """
    profile = dict(DEFAULT_EDITORIAL_PROFILE)
    if "profile" in plan:
        profile.update(_editorial_profile(plan["profile"]))
    if scene is not None:
        tts = scene.get("tts", {})
        if not isinstance(tts, dict):
            raise ValueError("editorial.scenes.tts: objeto obrigatório.")
        for key, choices in (("tone", EDITORIAL_TONES), ("intensity", EDITORIAL_INTENSITIES)):
            if key in tts:
                profile[key] = _choice(tts[key], f"editorial.scenes.tts.{key}", choices)
    return profile


def _editorial_intent(raw):
    if not isinstance(raw, dict) or set(raw) != set(DEFAULT_EDITORIAL_INTENT):
        raise ValueError("editorial.intent: objeto com mode, source_point, target e contribution obrigatório, sem campos adicionais.")
    target = raw["target"]
    if not isinstance(target, str) or len(target) > 240:
        raise ValueError("editorial.intent.target: texto de até 240 caracteres.")
    return {
        "mode": _choice(raw["mode"], "editorial.intent.mode", EDITORIAL_COMMENTARY_MODES),
        "source_point": _text(raw["source_point"], "editorial.intent.source_point", 240),
        "target": target.strip(),
        "contribution": _text(raw["contribution"], "editorial.intent.contribution", 240),
    }


def effective_editorial_intent(plan):
    """Resolve commentary acting without adding a field to legacy packages.

    The free text documents the written argument; it is never model direction.
    Only the validated mode selects a fixed instruction for literal speech.
    """
    return _editorial_intent(plan["intent"]) if "intent" in plan else dict(DEFAULT_EDITORIAL_INTENT)


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
    # Missing is the original visual. Keep old normalized packages byte-for-byte
    # equivalent; an explicit choice is metadata for the renderer, never TTS.
    if "visual_style" in raw:
        result["visual_style"] = _choice(raw["visual_style"], "editorial.visual_style", EDITORIAL_VISUAL_STYLES)
    if "profile" in raw:
        result["profile"] = _editorial_profile(raw["profile"])
    if "intent" in raw:
        result["intent"] = _editorial_intent(raw["intent"])
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
            if "motion" in visual:
                motion = visual["motion"]
                if not isinstance(motion, dict) or set(motion) - {"layout", "icon", "emphasis", "beats"}:
                    raise ValueError(f"{name}.visual.motion: campos permitidos layout, icon, emphasis, beats.")
                layouts = ("source_card", "statement", "comparison", "quote", "number", "timeline")
                icons = ("line-md:chat", "line-md:alert-circle", "line-md:confirm-circle", "line-md:clipboard-check")
                layout = motion.get("layout", "timeline" if "beats" in motion else "source_card")
                icon = motion.get("icon", "line-md:chat")
                emphasis = motion.get("emphasis", "")
                if layout not in layouts or icon not in icons:
                    raise ValueError(f"{name}.visual.motion: layout ou ícone fora do catálogo local.")
                if not isinstance(emphasis, str) or len(emphasis) > 50:
                    raise ValueError(f"{name}.visual.motion.emphasis: máximo 50 caracteres.")
                if emphasis and emphasis.casefold() not in normalized["visual"]["title"].casefold():
                    raise ValueError(f"{name}.visual.motion.emphasis precisa ser trecho literal do título visual.")
                if layout == "number" and not any(c.isdigit() for c in normalized["visual"]["title"] + " ".join(lines)):
                    raise ValueError(f"{name}.visual.motion.number exige número explícito no título ou apoio.")
                norm_motion = {"layout": layout, "icon": icon, "emphasis": emphasis}
                if "beats" in motion:
                    raw_beats = motion["beats"]
                    if not isinstance(raw_beats, list) or not 1 <= len(raw_beats) <= 8:
                        raise ValueError(f"{name}.visual.motion.beats: informe de 1 a 8 beats visuais.")
                    valid_types = ("headline", "metric", "strike_comparison", "comparison", "quote_card", "document_card", "source_focus")
                    valid_modes = ("window", "bottom", "hidden", "side")
                    norm_beats = []
                    for b_idx, b in enumerate(raw_beats):
                        b_name = f"{name}.visual.motion.beats[{b_idx}]"
                        if not isinstance(b, dict):
                            raise ValueError(f"{b_name}: beat deve ser um objeto.")
                        b_type = _choice(b.get("type", "headline"), f"{b_name}.type", valid_types)
                        anchor = str(b.get("anchor", ""))[:100].strip()
                        video_mode = _choice(b.get("video_mode", "hidden"), f"{b_name}.video_mode", valid_modes)
                        norm_beat = {"type": b_type, "anchor": anchor, "video_mode": video_mode}
                        if b_type == "metric":
                            norm_beat["value"] = _text(b.get("value", "0"), f"{b_name}.value", 30)
                            if "label" in b:
                                norm_beat["label"] = str(b["label"])[:120]
                            if "diff" in b:
                                norm_beat["diff"] = str(b["diff"])[:20]
                        elif b_type == "strike_comparison":
                            items = b.get("items", [])
                            if not isinstance(items, list) or not 2 <= len(items) <= 5:
                                raise ValueError(f"{b_name}.items: informe de 2 a 5 itens.")
                            norm_beat["items"] = [_text(it, f"{b_name}.items", 60) for it in items]
                            s_idx = b.get("strike_index", 1)
                            if not isinstance(s_idx, int) or not 0 <= s_idx < len(norm_beat["items"]):
                                raise ValueError(f"{b_name}.strike_index: índice válido no intervalo de items.")
                            norm_beat["strike_index"] = s_idx
                            if "summary" in b:
                                norm_beat["summary"] = str(b["summary"])[:80]
                        elif b_type == "comparison":
                            norm_beat["left_label"] = str(b.get("left_label", "01 / ANTES"))[:40]
                            norm_beat["left_text"] = _text(b.get("left_text", ""), f"{b_name}.left_text", 140)
                            norm_beat["right_label"] = str(b.get("right_label", "02 / DEPOIS"))[:40]
                            norm_beat["right_text"] = _text(b.get("right_text", ""), f"{b_name}.right_text", 140)
                            if "active_side" in b:
                                norm_beat["active_side"] = _choice(b["active_side"], f"{b_name}.active_side", ("left", "right", "both"))
                        elif b_type == "quote_card":
                            norm_beat["quote"] = _text(b.get("quote", ""), f"{b_name}.quote", 240)
                            if "author" in b:
                                norm_beat["author"] = str(b["author"])[:60]
                        elif b_type == "document_card":
                            norm_beat["issuer"] = _text(b.get("issuer", "OFICIAL"), f"{b_name}.issuer", 50)
                            norm_beat["text"] = _text(b.get("text", ""), f"{b_name}.text", 200)
                            if "date" in b:
                                norm_beat["date"] = str(b["date"])[:20]
                            if "stamp" in b:
                                norm_beat["stamp"] = str(b["stamp"])[:30]
                        elif b_type == "source_focus":
                            if "label" in b:
                                norm_beat["label"] = str(b["label"])[:80]
                        else:  # headline
                            if "title" in b:
                                norm_beat["title"] = str(b["title"])[:100]
                            if "emphasis" in b:
                                norm_beat["emphasis"] = str(b["emphasis"])[:50]
                        norm_beats.append(norm_beat)
                    norm_motion["beats"] = norm_beats
                normalized["visual"]["motion"] = norm_motion
            tts = scene.get("tts", {"delivery": "explain"})
            if not isinstance(tts, dict) or tts.get("delivery", "explain") not in ("hook", "explain", "contrast", "question", "closing"):
                raise ValueError(f"{name}.tts: direção vocal inválida.")
            for field, choices in (("tone", EDITORIAL_TONES), ("intensity", EDITORIAL_INTENSITIES)):
                if field in tts:
                    _choice(tts[field], f"{name}.tts.{field}", choices)
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


def voice_plan_fingerprint(plan):
    """Keep approved voice/alignment caches when only the preset changes.

    Accept the same normalized plan used by editorial_fingerprint. Exclude only
    this rendering-only field, preserving all previous cache decisions and the
    exact legacy hash for plans that never declared a visual style.
    """
    clean = {key: value for key, value in plan.items() if key != "visual_style"}
    if any("motion" in (scene.get("visual") or {}) for scene in clean.get("scenes", [])):
        # Pure visual motion instructions must never trigger another approved TTS.
        clean = json.loads(json.dumps(clean, ensure_ascii=False, allow_nan=False))
        for scene in clean["scenes"]:
            if "visual" in scene:
                scene["visual"].pop("motion", None)
    return editorial_fingerprint(clean)
