"""Align canonical editorial captions to approved TTS audio, without rewriting it.

The TTS manifest must already pass its content-fidelity gate. ASR supplies caption
times only; direct coverage must remain >=85%, with unmatched groups <=2 words.
One internal missing function word per scene may use <=60ms from the contiguous
previous ASR anchor while preserving >=80ms on that anchor. This is an explicitly
estimated caption boundary, never evidence that ASR detected the missing word.
All other unanchored words, missing prefixes and large gaps remain rejected.

CLI: python -m processor.editorial_alignment --audio-dir audio --model base
Requires faster-whisper only when running ASR; uses CPU/int8 and Portuguese.
"""
from __future__ import annotations

import argparse
from difflib import SequenceMatcher
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import unicodedata
import wave


VERSION = "os4-canonical-word-alignment-v3-generic-short-boundary"
MINIMUM_COVERAGE = 0.85
MAXIMUM_UNMATCHED_CANONICAL_GROUP = 2
SHORT_BOUNDARY_TOKENS = frozenset({"a", "o", "e", "de", "do", "da", "em", "no", "na", "ao", "que", "se"})
MAXIMUM_BORROWED_SECONDS = 0.060
MINIMUM_DONOR_SECONDS = 0.080
CONTIGUOUS_TOLERANCE_SECONDS = 0.0001
ESTIMATED_BOUNDARY_SOURCE = "estimated-joined-function-word-boundary"
_PROMPT_STOP_WORDS = frozenset({
    "a", "o", "as", "os", "um", "uma", "uns", "umas", "na", "no", "nas", "nos",
    "de", "do", "da", "dos", "das", "e", "em", "ao", "aos", "mas", "que", "se",
    "ela", "ele", "eles", "elas", "essa", "esse", "esses", "essas", "isso", "isto",
    "esta", "este", "estes", "estas", "qual", "quais", "como", "quando", "onde",
    "por", "para", "com", "sem", "sobre", "voce", "voces", "nosso", "nossa",
    "repara", "olha", "veja", "antes", "depois", "agora", "entao", "sim", "nao",
})


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized(token):
    plain = unicodedata.normalize("NFKD", token.casefold())
    return "".join(char for char in plain if not unicodedata.combining(char) and char.isalnum())


def canonical_words(narration):
    if not isinstance(narration, str):
        raise ValueError("Narração canônica precisa ser texto.")
    words = [token for token in re.findall(r"\S+", narration) if normalized(token)]
    if not words:
        raise ValueError("Narração canônica vazia.")
    return words


def build_vocabulary_prompt(manifest, *, maximum_terms=12, maximum_chars=180):
    """A bounded vocabulary hint, never the narration as an ASR initial prompt.

    Callers may supply asr_vocabulary as a list of short terms in the manifest.
    Otherwise capitalized names are extracted from canonical scene narrations.
    No person, organization or scene ID is hardcoded.
    """
    candidates = []
    explicit = manifest.get("asr_vocabulary", [])
    if isinstance(explicit, list):
        candidates.extend(term.strip() for term in explicit if isinstance(term, str)
                          and "\n" not in term and 1 <= len(term.split()) <= 4 and len(term) <= 50)
    for scene in manifest.get("scenes", []):
        text = str(scene.get("narration", ""))
        tokens = re.findall(r"[^\W\d_][\w'-]*", text, flags=re.UNICODE)
        group = []
        for token in [*tokens, ""]:
            is_name = bool(token and token[0].isupper() and len(normalized(token)) >= 3
                           and normalized(token) not in _PROMPT_STOP_WORDS)
            if is_name:
                group.append(token)
                if len(group) < 3:
                    continue
            if group:
                candidates.append(" ".join(group))
                group = []
    terms, seen = [], set()
    for term in candidates:
        key = normalized(term)
        if not key or key in seen:
            continue
        proposed = ", ".join([*terms, term])
        if len(proposed) > maximum_chars:
            continue
        terms.append(term)
        seen.add(key)
        if len(terms) >= maximum_terms:
            break
    return ", ".join(terms)


def split_timed_asr_words(segments):
    """Expand provider word groups while retaining their measured audio span."""
    words, segment_texts = [], []
    for segment in segments:
        segment_texts.append(str(segment.text).strip())
        for word in segment.words or []:
            tokens = [token for token in re.findall(r"\S+", word.word) if normalized(token)]
            if not tokens:
                continue
            start, end = max(0.0, float(word.start)), max(0.0, float(word.end))
            weights = [max(1, len(normalized(token))) for token in tokens]
            position, total = 0, sum(weights)
            for token, weight in zip(tokens, weights):
                words.append({"texto": token, "inicio": start + (end - start) * position / total,
                              "fim": start + (end - start) * (position + weight) / total})
                position += weight
    return words, " ".join(segment_texts)


def fold_split_canonical_words(words, expected):
    """Join an ASR spelling only when its concatenation is a canonical token."""
    vocabulary = {normalized(word) for word in expected}
    result, index = [], 0
    while index < len(words):
        pair = words[index:index + 2]
        joined = "".join(normalized(word["texto"]) for word in pair)
        separate_canonical_tokens = len(pair) == 2 and all(normalized(word["texto"]) in vocabulary for word in pair)
        if len(pair) == 2 and joined in vocabulary and not separate_canonical_tokens:
            result.append({"texto": joined, "inicio": pair[0]["inicio"], "fim": pair[1]["fim"],
                           "asr_original": " ".join(word["texto"] for word in pair),
                           "timing_source": "asr-span-joined-canonical-token"})
            index += 2
        else:
            result.append(dict(words[index]))
            index += 1
    return result


def distribute_canonical_span(tokens, start, end, method):
    if not math.isfinite(start) or not math.isfinite(end) or end <= start:
        raise ValueError("Não há intervalo de áudio positivo para as palavras canônicas.")
    weights = [max(1, len(normalized(token))) for token in tokens]
    position, total, result = 0, sum(weights), []
    for token, weight in zip(tokens, weights):
        result.append({"texto": token, "inicio": start + (end - start) * position / total,
                       "fim": start + (end - start) * (position + weight) / total,
                       "timing_source": method})
        position += weight
    return result


def _resolve_short_boundary(tokens, left, right):
    if len(tokens) != 1 or normalized(tokens[0]) not in SHORT_BOUNDARY_TOKENS:
        return None
    if abs(left["fim"] - right["inicio"]) > CONTIGUOUS_TOLERANCE_SECONDS:
        return None
    borrowed = min(MAXIMUM_BORROWED_SECONDS, left["fim"] - left["inicio"] - MINIMUM_DONOR_SECONDS)
    start, end = left["fim"] - borrowed, right["inicio"]
    if borrowed <= 0 or round(end, 4) <= round(start, 4):
        return None
    original = dict(left)
    left["fim"] = start
    left["timing_source"] = "asr-span-tail-adjusted-for-function-word"
    word = {"texto": tokens[0], "inicio": start, "fim": end, "timing_source": ESTIMATED_BOUNDARY_SOURCE}
    return word, {
        "timing_source": ESTIMATED_BOUNDARY_SOURCE, "estimated": True, "exact_asr_match": False,
        "borrowed_seconds": round(borrowed, 6), "donor_original": original,
        "donor_adjusted": dict(left), "unchanged_right_anchor": dict(right), "audio_modified": False,
    }


def align_scene(narration, asr_words, duration):
    expected = canonical_words(narration)
    if not isinstance(duration, (float, int)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("Duração de áudio positiva e finita obrigatória.")
    for word in asr_words:
        if not all(isinstance(word.get(key), (float, int)) and math.isfinite(word[key]) for key in ("inicio", "fim")):
            raise ValueError("ASR contém tempos não finitos ou ausentes.")
    observed = fold_split_canonical_words(asr_words, expected)
    opcodes = SequenceMatcher(None, [normalized(word) for word in expected],
                              [normalized(word["texto"]) for word in observed], autojunk=False).get_opcodes()
    matched = sum(i2 - i1 for tag, i1, i2, _, _ in opcodes if tag == "equal")
    coverage = matched / len(expected)
    diagnostics = {
        "canonical_word_count": len(expected), "asr_word_count": len(asr_words),
        "matching_asr_word_count": len(observed), "direct_matched_word_count": matched,
        "direct_coverage": round(coverage, 6), "minimum_required_coverage": MINIMUM_COVERAGE,
        "maximum_unmatched_canonical_group": MAXIMUM_UNMATCHED_CANONICAL_GROUP,
        "corrections": [], "asr_insertions": [], "boundary_resolutions": [], "failures": [],
        "content_fidelity_gate": "required-separately-in-tts-manifest",
    }
    failures = diagnostics["failures"]
    if coverage < MINIMUM_COVERAGE:
        failures.append(f"Cobertura direta {coverage:.3f} abaixo de {MINIMUM_COVERAGE:.2f}.")
    aligned = [None] * len(expected)
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "equal":
            for canonical_index, asr_index in zip(range(i1, i2), range(j1, j2)):
                word = observed[asr_index]
                aligned[canonical_index] = {"texto": expected[canonical_index], "inicio": word["inicio"],
                                            "fim": word["fim"], "timing_source": word.get("timing_source", "asr-exact-normalized")}
        elif tag == "insert":
            diagnostics["asr_insertions"].append({"after_canonical_index": i1 - 1,
                "asr_text": " ".join(word["texto"] for word in observed[j1:j2]),
                "inicio": observed[j1]["inicio"], "fim": observed[j2 - 1]["fim"]})
    for tag, i1, i2, j1, j2 in opcodes:
        if tag not in {"replace", "delete"}:
            continue
        tokens = expected[i1:i2]
        correction = {"canonical_start_index": i1, "canonical_text": " ".join(tokens),
                      "asr_text": " ".join(word["texto"] for word in observed[j1:j2]),
                      "canonical_count": len(tokens), "kind": tag, "accepted": False}
        if len(tokens) > MAXIMUM_UNMATCHED_CANONICAL_GROUP:
            failures.append(f"Grupo canônico ausente/divergente de {len(tokens)} palavras no índice {i1}.")
        elif tag == "replace" and j1 < j2:
            aligned[i1:i2] = distribute_canonical_span(tokens, observed[j1]["inicio"], observed[j2 - 1]["fim"], "asr-span-canonical-correction")
            correction["accepted"] = True
        elif 0 < i1 and i2 < len(expected) and aligned[i1 - 1] is not None and aligned[i2] is not None:
            left, right = aligned[i1 - 1], aligned[i2]
            start, end = left["fim"], right["inicio"]
            contiguous = abs(end - start) <= CONTIGUOUS_TOLERANCE_SECONDS
            resolution = None
            if contiguous and not diagnostics["boundary_resolutions"]:
                resolution = _resolve_short_boundary(tokens, left, right)
            if resolution:
                word, details = resolution
                aligned[i1] = word
                details.update({"canonical_index": i1, "canonical_word": tokens[0], "donor_canonical_index": i1 - 1})
                diagnostics["boundary_resolutions"].append(details)
                correction.update({"accepted": True, "resolution": ESTIMATED_BOUNDARY_SOURCE})
            elif not contiguous and 0 < end - start <= max(1.2, len(tokens) * 0.7):
                aligned[i1:i2] = distribute_canonical_span(tokens, start, end, "interpolated-between-asr-anchors")
                correction["accepted"] = True
            else:
                failures.append(f"Intervalo inadequado entre âncoras no índice {i1}.")
        else:
            failures.append(f"Grupo ausente sem duas âncoras no índice {i1}.")
        diagnostics["corrections"].append(correction)
    for insertion in diagnostics["asr_insertions"]:
        if len(insertion["asr_text"].split()) > 2:
            failures.append("Grupo ASR adicional com mais de duas palavras; revisar áudio.")
    if any(word is None for word in aligned):
        failures.append("Existem palavras canônicas sem tempo confiável.")
    previous_start = -1.0
    for index, word in enumerate(aligned):
        if word is None:
            continue
        start, end = float(word["inicio"]), min(duration, float(word["fim"]))
        if start < 0 or start < previous_start - 0.03 or round(end, 4) <= round(start, 4) or word["fim"] > duration + 0.12:
            failures.append(f"Tempo inválido/não monotônico na palavra {index}.")
            break
        previous_start = start
    diagnostics["passed"] = not failures
    diagnostics["final_canonical_coverage"] = round(sum(word is not None for word in aligned) / len(expected), 6)
    diagnostics["timing_sources"] = [word["timing_source"] if word else "unresolved" for word in aligned]
    diagnostics["unresolved_word_count"] = sum(word is None for word in aligned)
    if diagnostics["passed"] and [word["texto"] for word in aligned] != expected:
        raise AssertionError("Alinhamento tentou alterar texto canônico.")
    words = [{"texto": word["texto"], "inicio": round(word["inicio"], 4), "fim": round(min(duration, word["fim"]), 4),
              "timing_source": word["timing_source"], "estimated": word["timing_source"] in {
                  ESTIMATED_BOUNDARY_SOURCE, "interpolated-between-asr-anchors", "asr-span-canonical-correction"}}
             for word in aligned if word is not None]
    return words, diagnostics


def audio_duration(path):
    with wave.open(str(path), "rb") as source:
        return source.getnframes() / source.getframerate()


def _audio_path(audio_dir, filename):
    if not isinstance(filename, str) or not filename or Path(filename).is_absolute():
        raise ValueError("Arquivo de áudio deve ser relativo ao diretório do manifesto.")
    root, target = Path(audio_dir).resolve(), (Path(audio_dir) / filename).resolve()
    if not target.is_relative_to(root) or target.suffix.lower() != ".wav":
        raise ValueError("Arquivo WAV fora do diretório do manifesto ou inválido.")
    return target


def validate_manifest(manifest, audio_dir):
    if manifest.get("status") != "success" or not isinstance(manifest.get("scenes"), list) or not manifest["scenes"]:
        raise ValueError("Narração ainda não concluída; alinhamento não executado.")
    identifiers = set()
    for scene in manifest["scenes"]:
        identifier = scene.get("id")
        if not isinstance(identifier, str) or not identifier or identifier in identifiers:
            raise ValueError("IDs de cena ausentes ou repetidos no manifesto.")
        identifiers.add(identifier)
        canonical_words(scene.get("narration"))
        if scene.get("output_fidelity", {}).get("passed") is not True:
            raise ValueError(f"Fidelidade de conteúdo TTS não aprovada: {identifier}")
        if scene.get("narration_sha256") != hashlib.sha256(scene["narration"].encode("utf-8")).hexdigest():
            raise ValueError(f"Hash do roteiro divergiu do manifesto: {identifier}")
        if scene.get("audio_sha256") != sha256_file(_audio_path(audio_dir, scene.get("file"))):
            raise ValueError(f"Hash do WAV divergiu do manifesto: {identifier}")


def cache_valid(cache, manifest, audio_dir, model):
    try:
        validate_manifest(manifest, audio_dir)
        if not cache or cache.get("version") != VERSION or cache.get("status") != "success" or cache.get("asr_model") != model:
            return False
        if cache.get("initial_prompt") != build_vocabulary_prompt(manifest):
            return False
        scenes = {scene["id"]: scene for scene in cache.get("scenes", [])}
        if len(scenes) != len(cache.get("scenes", [])) or set(scenes) != {scene["id"] for scene in manifest["scenes"]}:
            return False
        for scene in manifest["scenes"]:
            cached, audio = scenes[scene["id"]], _audio_path(audio_dir, scene["file"])
            if cached.get("audio_sha256") != scene["audio_sha256"] or cached.get("narration_sha256") != scene["narration_sha256"]:
                return False
            diagnostics = cached.get("diagnostics", {})
            if not diagnostics.get("passed") or diagnostics.get("failures") or cached.get("coverage", 0) < MINIMUM_COVERAGE:
                return False
            if diagnostics.get("direct_coverage") != cached.get("coverage"):
                return False
            expected = canonical_words(scene["narration"])
            if [word["texto"] for word in cached.get("palavras", [])] != expected:
                return False
            if len(diagnostics.get("timing_sources", [])) != len(expected) or "unresolved" in diagnostics["timing_sources"]:
                return False
            duration, previous_start = audio_duration(audio), -1.0
            for word in cached["palavras"]:
                start, end = word["inicio"], word["fim"]
                if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration + .01) or start < previous_start - .03:
                    return False
                previous_start = start
        return True
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def align_audio_directory(audio_dir, *, model="base"):
    audio_dir = Path(audio_dir).resolve()
    manifest = json.loads((audio_dir / "narration-manifest.json").read_text(encoding="utf-8-sig"))
    validate_manifest(manifest, audio_dir)
    output_file = audio_dir / "aligned-words.json"
    try:
        cached = json.loads(output_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cached = None
    if cache_valid(cached, manifest, audio_dir, model):
        return cached
    from faster_whisper import WhisperModel
    asr = WhisperModel(model, device="cpu", compute_type="int8")
    vocabulary = build_vocabulary_prompt(manifest)
    result = {"version": VERSION, "status": "running", "asr_engine": "faster-whisper",
              "asr_package_version": importlib.metadata.version("faster-whisper"), "asr_model": model,
              "device": "cpu", "compute_type": "int8", "language": "pt", "word_timestamps": True,
              "initial_prompt": vocabulary, "canonical_text_preserved": True,
              "minimum_required_coverage": MINIMUM_COVERAGE, "tts_fidelity_required_separately": True, "scenes": []}
    for scene in manifest["scenes"]:
        audio = _audio_path(audio_dir, scene["file"])
        duration = audio_duration(audio)
        segments, info = asr.transcribe(str(audio), language="pt", word_timestamps=True,
            initial_prompt=vocabulary or None, beam_size=5, condition_on_previous_text=False, vad_filter=False)
        asr_words, asr_text = split_timed_asr_words(segments)
        words, diagnostics = align_scene(scene["narration"], asr_words, duration)
        result["scenes"].append({"id": scene["id"], "file": scene["file"], "audio_sha256": scene["audio_sha256"],
            "narration_sha256": scene["narration_sha256"], "duration_seconds": round(duration, 6),
            "narration": scene["narration"], "asr_text": asr_text, "asr_language": info.language,
            "coverage": diagnostics["direct_coverage"], "palavras": words, "diagnostics": diagnostics})
        output_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"id": scene["id"], "coverage": diagnostics["direct_coverage"], "passed": diagnostics["passed"],
                          "words": len(words)}, ensure_ascii=False), flush=True)
    result["status"] = "success" if all(scene["diagnostics"]["passed"] for scene in result["scenes"]) else "failed-alignment"
    output_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if result["status"] != "success":
        raise RuntimeError("Alinhamento reprovado; consultar diagnósticos sem substituir roteiro por ASR.")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-dir", required=True)
    parser.add_argument("--model", default="base")
    args = parser.parse_args(argv)
    result = align_audio_directory(args.audio_dir, model=args.model)
    print(json.dumps({"status": result["status"], "version": VERSION, "scenes": len(result["scenes"])}))


if __name__ == "__main__":
    main()
