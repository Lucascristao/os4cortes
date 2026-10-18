"""Compose a validated editorial plan with original clips and literal narration.

Scene video caches are silent: changing one scene or the shared master gain does
not re-encode unrelated scenes. Raw narration WAVs are never rewritten. The
compositor owns a separate audio master and applies one common voice gain there.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import wave

from . import captions, editorial_alignment
from .editorial_plan import normalize_editorial_plan, validate_source_ranges
from .editorial_voice import prepare_voice_jobs, synthesize_editorial_voice
from .lower_third import LowerThird
from .voice_runtime.gemini_live_fidelity import evaluate_transcription


VERSION = "os4-editorial-compositor-v2-bounded-overlay-input"
MASTER_AUDIO_VERSION = "os4-editorial-master-v2-shared-baritone"
DEFAULT_NARRATOR_PITCH_SEMITONES = -1.0


class StaleVoicePolicy(ValueError):
    """Intact audio was generated with a different voice policy/direction."""


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _run(command):
    result = subprocess.run([str(item) for item in command], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(f"Media command failed ({Path(str(command[0])).name}): {result.stderr[-5000:]}")
    return result


def _filter_path(path):
    return str(Path(path).resolve()).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


@contextmanager
def _tool_path(ffmpeg, ffprobe):
    """Existing tracking APIs invoke ffmpeg by name; honor explicit bin paths."""
    previous = os.environ.get("PATH", "")
    directories = []
    for index, executable in enumerate((ffmpeg, ffprobe)):
        resolved = shutil.which(str(executable)) or (str(Path(executable).resolve()) if Path(executable).is_file() else None)
        if not resolved and index == 0:
            raise FileNotFoundError(f"Required media executable unavailable: {executable}")
        if resolved:
            directories.append(str(Path(resolved).resolve().parent))
    os.environ["PATH"] = os.pathsep.join(dict.fromkeys(directories)) + os.pathsep + previous
    try:
        yield
    finally:
        os.environ["PATH"] = previous


def build_timeline(plan, voice_durations, *, fps=30):
    """Real WAV durations determine narration; ceil frames never cut its tail."""
    if isinstance(fps, bool) or not isinstance(fps, int) or fps <= 0:
        raise ValueError("fps must be a positive integer.")
    result, cursor = [], 0
    for scene in plan["scenes"]:
        duration = voice_durations[scene["id"]] if scene["kind"] == "narration" else scene["end"] - scene["start"]
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError(f"Invalid real duration in scene {scene['id']}.")
        frames = max(1, math.ceil(duration * fps - 1e-8))
        result.append({"id": scene["id"], "kind": scene["kind"], "content_duration": duration,
                       "duration": frames / fps, "frames": frames, "start": cursor / fps,
                       "end": (cursor + frames) / fps})
        cursor += frames
    return result


def _safe_audio_path(root, name):
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise ValueError("Voice filename must be relative to its bundle.")
    result = (Path(root).resolve() / name).resolve()
    if not result.is_relative_to(Path(root).resolve()) or result.suffix.lower() != ".wav":
        raise ValueError("Voice WAV escaped its bundle directory.")
    return result


def _effective_overrides(manifest, delivery_overrides, plan):
    if delivery_overrides is not None:
        return delivery_overrides
    # Only the unchanged external proof may carry its approved in-memory
    # directions implicitly. Production local bundles follow the current plan
    # unless the caller explicitly authorizes overrides on this invocation.
    external = manifest.get("runtime_source") == "external-ode" or manifest.get("ode_checkout_required") is True
    if external and manifest.get("source_plan_fingerprint") == fingerprint(normalize_editorial_plan(plan)):
        return manifest.get("direction_overrides_in_memory", {})
    return {}


def _validate_voice_policy(plan, voice_dir, manifest, voices, delivery_overrides):
    _, expected_jobs, expected = prepare_voice_jobs(plan, output_dir=voice_dir,
        delivery_overrides=_effective_overrides(manifest, delivery_overrides, plan))
    for field in ("voice_policy_fingerprint", "speech_profile_fingerprint", "global_direction_fingerprint"):
        if manifest.get(field) != expected[field]:
            raise StaleVoicePolicy(f"Narration bundle uses a stale OS4 voice direction/policy: {field}")
    for job in expected_jobs:
        row = voices[job["scene_id"]]["metadata"]
        sidecar = _json(voices[job["scene_id"]]["path"].with_suffix(".tts.json"))
        if row.get("scene_direction_fingerprint") != job["direction_fingerprint"] or sidecar.get("scene_direction_fingerprint") != job["direction_fingerprint"]:
            raise StaleVoicePolicy(f"Narration scene direction changed: {job['scene_id']}")
        for field in ("voice_policy_fingerprint", "speech_profile_fingerprint"):
            if sidecar.get(field) != expected[field]:
                raise StaleVoicePolicy(f"Narration sidecar uses a stale voice policy: {job['scene_id']} / {field}")
    # Worker checkout paths and source-file hashes intentionally do not enter
    # this check: compatible external ODE and the local port have equal policy.


def validate_voice_bundle(plan, voice_dir, *, require_alignment=True, delivery_overrides=None, validate_policy=True):
    """Reject altered text/audio/captions; provider fidelity and ASR are separate."""
    voice_dir = Path(voice_dir).resolve()
    manifest = _json(voice_dir / "narration-manifest.json")
    if manifest.get("status") != "success" or manifest.get("model") != "gemini-3.8-live" or manifest.get("voice") != "Charon":
        raise ValueError("Narration bundle has not passed the approved model/voice gate.")
    expected = {scene["id"]: scene["text"] for scene in plan["scenes"] if scene["kind"] == "narration"}
    rows = manifest.get("scenes", [])
    if len(rows) != len(expected) or {row.get("id") for row in rows} != set(expected):
        raise ValueError("Narration scene IDs do not match the editorial plan.")
    voices = {}
    for row in rows:
        text = expected[row["id"]]
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        audio = _safe_audio_path(voice_dir, row.get("file"))
        sidecar = _json(audio.with_suffix(".tts.json"))
        if row.get("narration") != text or row.get("narration_sha256") != text_hash or sidecar.get("narration_sha256") != text_hash:
            raise ValueError(f"Narration text/hash differs from the plan: {row['id']}")
        audio_hash = file_sha256(audio)
        if row.get("audio_sha256") != audio_hash or sidecar.get("audio_sha256") != audio_hash:
            raise ValueError(f"Narration WAV hash mismatch: {row['id']}")
        if sidecar.get("model") != "gemini-3.8-live" or sidecar.get("voice") != "Charon":
            raise ValueError("Voice sidecar model/voice mismatch.")
        if not row.get("output_fidelity", {}).get("passed") or not sidecar.get("output_fidelity", {}).get("passed"):
            raise ValueError(f"Literal TTS fidelity failed: {row['id']}")
        # Custom pronunciations have already passed the runtime gate. The
        # canonical word check remains strict, with the same explicit aliases.
        pronunciations = row.get("scene_direction", {}).get("pronunciations", {})
        for transcript in (row.get("output_transcription", ""), sidecar.get("output_transcription", "")):
            if not evaluate_transcription(text, transcript, pronunciations)["passed"]:
                raise ValueError(f"Provider transcript diverges from literal script: {row['id']}")
        with wave.open(str(audio), "rb") as handle:
            if (handle.getnchannels(), handle.getsampwidth(), handle.getframerate()) != (1, 2, 24000):
                raise ValueError("Expected untouched Gemini PCM16 mono 24kHz WAV.")
            duration = handle.getnframes() / handle.getframerate()
        if duration <= 0 or abs(float(row.get("duration_seconds", -1)) - duration) > .05:
            raise ValueError("Voice WAV duration differs from its manifest.")
        voices[row["id"]] = {"path": audio, "duration": duration, "sha256": audio_hash, "metadata": row}
    if validate_policy:
        _validate_voice_policy(plan, voice_dir, manifest, voices, delivery_overrides)
    aligned = None
    if require_alignment:
        aligned = _json(voice_dir / "aligned-words.json")
        rows = aligned.get("scenes", [])
        if aligned.get("version") != editorial_alignment.VERSION or aligned.get("status") != "success" or len(rows) != len(expected) or {row.get("id") for row in rows} != set(expected):
            raise ValueError("Canonical caption alignment has not passed all narration scenes.")
        for row in rows:
            identifier = row["id"]
            if row.get("audio_sha256") != voices[identifier]["sha256"] or row.get("narration_sha256") != voices[identifier]["metadata"]["narration_sha256"]:
                raise ValueError("Aligned captions refer to stale audio/text.")
            diagnostics = row.get("diagnostics", {})
            if not diagnostics.get("passed") or diagnostics.get("failures") or row.get("coverage", 0) < .85:
                raise ValueError("Caption alignment coverage or missing-word gate failed.")
            words = row.get("palavras", [])
            expected_words = editorial_alignment.canonical_words(expected[identifier])
            if [word.get("texto") for word in words] != expected_words:
                raise ValueError("Caption spelling/order differs from the canonical script.")
            sources = diagnostics.get("timing_sources", [])
            if len(sources) != len(words) or "unresolved" in sources:
                raise ValueError("Caption word timing has unresolved entries.")
            previous = -1.0
            for word in words:
                start, end = word["inicio"], word["fim"]
                if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= voices[identifier]["duration"] + .01) or start < previous - .03:
                    raise ValueError("Caption times are invalid or out of chronological order.")
                previous = start
            voices[identifier]["words"] = words
            voices[identifier]["alignment_diagnostics"] = diagnostics
    return manifest, voices, aligned


def _ensure_voice_bundle(plan, voice_dir, *, allow_synthesis, delivery_overrides, asr_model):
    manifest_file = Path(voice_dir) / "narration-manifest.json"
    ready = False
    if manifest_file.is_file():
        try:
            ready = _json(manifest_file).get("status") == "success"
        except (ValueError, OSError):
            pass
    if not ready:
        if not allow_synthesis:
            raise ValueError("Voice bundle missing/unsuccessful and synthesis is disabled.")
        synthesize_editorial_voice(plan, output_dir=voice_dir, delivery_overrides=delivery_overrides)
    # A successful but corrupted/stale bundle must fail; do not silently spend
    # paid requests to hide an integrity error.
    # Verify integrity first. Only an intact stale policy may trigger the
    # authorized runtime refresh; corrupted audio/text is never paid-repaired.
    manifest, voices, _ = validate_voice_bundle(plan, voice_dir, require_alignment=False, validate_policy=False)
    try:
        _validate_voice_policy(plan, voice_dir, manifest, voices, delivery_overrides)
    except StaleVoicePolicy:
        if not allow_synthesis:
            raise
        delivery_overrides = _effective_overrides(manifest, delivery_overrides, plan)
        synthesize_editorial_voice(plan, output_dir=voice_dir, delivery_overrides=delivery_overrides)
        manifest, voices, _ = validate_voice_bundle(plan, voice_dir, require_alignment=False,
                                                   delivery_overrides=delivery_overrides)
    # A provider transcript may omit a repetition present in its PCM. The ASR
    # gate remains strict; permit one fresh performance of only rejected scenes.
    # Infrastructure/model errors and stale diagnostics must not buy new audio.
    try:
        editorial_alignment.align_audio_directory(voice_dir, model=asr_model)
    except RuntimeError:
        rejected = _rejected_alignment_scenes(voice_dir, voices)
        if not allow_synthesis or not rejected:
            raise
        print(f"Refazendo uma vez as falas rejeitadas pelo alinhamento: {', '.join(rejected)}", flush=True)
        overrides = _effective_overrides(manifest, delivery_overrides, plan)
        synthesize_editorial_voice(plan, output_dir=voice_dir, delivery_overrides=overrides,
                                  force_scene_ids=rejected)
        validate_voice_bundle(plan, voice_dir, require_alignment=False, delivery_overrides=delivery_overrides)
        editorial_alignment.align_audio_directory(voice_dir, model=asr_model)
    return validate_voice_bundle(plan, voice_dir, delivery_overrides=delivery_overrides)


def _rejected_alignment_scenes(voice_dir, voices):
    try:
        result = _json(Path(voice_dir) / "aligned-words.json")
        if result.get("version") != editorial_alignment.VERSION or result.get("status") != "failed-alignment":
            return []
        rows = result.get("scenes", [])
        if len(rows) != len(voices) or {row.get("id") for row in rows} != set(voices):
            return []
        if any(row.get("audio_sha256") != voices[row["id"]]["sha256"] for row in rows):
            return []
        return [row["id"] for row in rows if row.get("diagnostics", {}).get("passed") is False
                and row.get("diagnostics", {}).get("failures")]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def _wave_stats(path):
    import numpy as np
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2:
            raise ValueError("Audio analysis expects PCM16.")
        rate, channels = handle.getframerate(), handle.getnchannels()
        values = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype(np.float64) / 32768
    if channels != 1:
        raise ValueError("Audio analysis expects a mono speech source.")
    if not values.size:
        raise ValueError("Empty audio source.")
    window = max(1, round(rate * .02))
    windows = np.pad(values, (0, (-len(values)) % window)).reshape(-1, window)
    energy = np.mean(windows * windows, axis=1)
    active = energy > 10 ** (-45 / 10)
    if not np.any(active):
        raise ValueError("Speech source has no measurable active audio.")
    return {"duration": len(values) / rate, "active_energy": float(energy[active].sum()),
            "active_windows": int(active.sum()), "active_rms": float(np.sqrt(energy[active].mean())),
            "peak": float(np.max(np.abs(values)))}


def _cache_valid(record_path, key, artifact):
    try:
        record = _json(record_path)
        return record.get("key") == key and Path(artifact).is_file() and record.get("sha256") == file_sha256(artifact)
    except (OSError, ValueError, KeyError):
        return False


def _save_cache(record_path, key, artifact):
    _write_json(record_path, {"key": key, "sha256": file_sha256(artifact)})


def scene_fingerprint(scene, *, source_hash, canvas, lower_third, words, voice=None, font_hash=""):
    """Exclude other scenes and master audio gain from silent video cache keys."""
    from .editorial_visuals import VISUAL_STYLE_VERSION
    return fingerprint({"version": VERSION, "scene": scene, "source": source_hash,
                        "canvas": canvas, "lower_third": lower_third, "words": words,
                        "voice_timing": voice, "font": font_hash,
                        **({"visual_style": VISUAL_STYLE_VERSION} if scene.get("kind") == "narration" else {})})


def _font(font_dir):
    from PIL import ImageFont
    candidates = []
    if font_dir:
        directory = Path(font_dir).expanduser()
        candidates = [directory] if directory.is_file() else [directory / name for name in ("ArchivoBlack-Regular.ttf", "arial.ttf", "Arial.ttf", "DejaVuSans-Bold.ttf")]
    else:
        candidates = [captions.DEFAULT_FONT_DIR / "ArchivoBlack-Regular.ttf", "Arial.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"]
    for candidate in candidates:
        try:
            measured = ImageFont.truetype(str(candidate), 20)
            path = Path(measured.path).resolve()
            return path, measured.getname()[0]
        except OSError:
            continue
    raise FileNotFoundError("Supply font_dir with a local Archivo Black or Arial TTF. No font is downloaded by this compositor.")


def _caption_assets(words, scene_dir, *, canvas, font_path, font_name, duration, credit=""):
    from PIL import ImageFont
    zones = canvas.safe_zones()
    left, top, right, bottom = zones["captions"]
    size = max(18, round((76 if canvas.portrait else 56) * min(canvas.width, canvas.height) / 1080))
    style = captions.CaptionStyle(font_name=font_name, font_size=size, margin_v=canvas.height-bottom,
                                  max_words=5 if canvas.portrait else 7, max_chars=31 if canvas.portrait else 48,
                                  line_chars=21 if canvas.portrait else 32)
    measured = ImageFont.truetype(str(font_path), size)
    groups = captions.agrupar_palavras(words, style)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {canvas.width}
PlayResY: {canvas.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Clean,{font_name},{size},&H00FFFFFF,&H0000FFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,0,2,{left},{canvas.width-right},{style.margin_v},1
Style: Credit,{font_name},{max(16,round(size*.38))},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,1,0,7,{left},{canvas.width-right},{max(20,round(canvas.height*.035))},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    events, cues, srt_lines = [], [], []
    for group_index, group in enumerate(groups, 1):
        start, end = group[0]["inicio"], min(duration, group[-1]["fim"])
        text = captions.texto_srt_grupo(group, style.line_chars)
        cues.append({"start": start, "end": end, "text": text})
        srt_lines.extend([str(group_index), f"{captions.srt_tempo(start)} --> {captions.srt_tempo(end)}", text, ""])
        measured_width = max(measured.getlength(line) for line in text.splitlines())
        fit_size = min(size, max(14, int(size * (right-left) / max(1, measured_width))))
        for index, word in enumerate(group):
            word_start = max(0, word["inicio"])
            word_end = min(duration, group[index+1]["inicio"] if index+1 < len(group) else word["fim"])
            if word_end <= word_start:
                continue
            rendered = captions.texto_ass_grupo(group, index, style.line_chars)
            if fit_size < size:
                rendered = r"{\fs" + str(fit_size) + "}" + rendered
            events.append(f"Dialogue: 0,{captions.ass_tempo(word_start)},{captions.ass_tempo(word_end)},Clean,,0,0,0,,{rendered}")
    if credit:
        events.append(f"Dialogue: 1,{captions.ass_tempo(0)},{captions.ass_tempo(duration)},Credit,,0,0,0,,{captions.escapar_ass(credit)}")
    ass = scene_dir / "captions.ass"
    ass.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    (scene_dir / "captions.srt").write_text("\n".join(srt_lines), encoding="utf-8")
    return ass, cues


def _overlay_animation_entries(stages, *, canvas):
    """Finite RGBA frames: ease only the changing text; leave branding still."""
    from PIL import Image, ImageChops, ImageDraw
    entries, previous, last_image = ["ffconcat version 1.0"], None, None

    def append(path, frames):
        nonlocal last_image
        if frames <= 0:
            return
        quoted = str(path.resolve()).replace("\\", "/").replace("'", "'\\''")
        entries.extend([f"file '{quoted}'", f"option framerate {canvas.fps}", f"duration {frames/canvas.fps:.9f}"])
        last_image = quoted

    for path, frames in stages:
        with Image.open(path) as source:
            current = source.convert("RGBA")
        if previous is None:
            append(path, frames)
            previous = current
            continue
        difference = ImageChops.difference(previous, current)
        mask = difference.getchannel("A")
        for channel in ("R", "G", "B"):
            mask = ImageChops.lighter(mask, difference.getchannel(channel))
        box = mask.getbbox()
        transition_frames = min(frames, max(1, round(canvas.fps*.24))) if box else 0
        if transition_frames:
            base = previous.copy()
            ImageDraw.Draw(base).rectangle((box[0], box[1], box[2]-1, box[3]-1), fill=(0, 0, 0, 0))
            old, new = previous.crop(box), current.crop(box)
            for frame in range(1, transition_frames):
                eased = 1-(1-frame/transition_frames)**3
                composed = base.copy()
                outgoing, incoming = old.copy(), new.copy()
                outgoing.putalpha(old.getchannel("A").point(lambda value: round(value*(1-eased))))
                incoming.putalpha(new.getchannel("A").point(lambda value: round(value*eased)))
                composed.alpha_composite(outgoing, (box[0], box[1]))
                drift = round(18*min(canvas.width, canvas.height)/1080*(1-eased))
                composed.alpha_composite(incoming, (box[0], box[1]+drift))
                animated = path.with_name(f"{path.stem}-motion-{frame:02d}.png")
                composed.save(animated, compress_level=3)
                append(animated, 1)
            append(path, frames-transition_frames+1)
        else:
            append(path, frames)
        previous = current
    if last_image is None:
        raise ValueError("No visible overlay stage fits the scene duration.")
    entries.extend([f"file '{last_image}'", f"option framerate {canvas.fps}"])
    return entries


def _encode_silent_scene(video, scene, scene_dir, output, *, canvas, treatment, ass, font_path, duration, ffmpeg, shared_dir, source_hash):
    from .editorial_visuals import EditorialScene, VISUAL_STYLE_VERSION, build_background_filter, render_overlay_png, overlay_timeline
    common = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
              "-r", str(canvas.fps), "-frames:v", str(round(duration*canvas.fps)),
              "-threads", "2", "-video_track_timescale", "15360", "-movflags", "+faststart"]
    caption_filter = f"ass='{_filter_path(ass)}':fontsdir='{_filter_path(font_path.parent)}'"
    if scene["kind"] == "clip":
        from .tracking import render_tracking_9x16, render_cinematic_16x9
        tracked = scene_dir / "tracked.mp4"
        tracking_key = fingerprint({"source": source_hash, "start": scene["start"], "end": scene["end"], "canvas": [canvas.width, canvas.height], "lower_third": [treatment.mode, treatment.height_fraction]})
        if not _cache_valid(scene_dir / "tracked-cache.json", tracking_key, tracked):
            renderer = render_tracking_9x16 if canvas.portrait else render_cinematic_16x9
            renderer(video, scene["start"], scene["end"], tracked, work_dir=scene_dir / "tracking",
                     largura_saida=canvas.width, altura_saida=canvas.height, lower_third=treatment)
            _save_cache(scene_dir / "tracked-cache.json", tracking_key, tracked)
        _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-filter_threads", "1", "-threads", "1", "-i", tracked, "-an", "-vf",
              f"fps={canvas.fps},setsar=1,tpad=stop_mode=clone:stop_duration=0.10,{caption_filter}", *common, output])
        return
    visual = scene["visual"]
    if len(visual.get("lines", [])) > 3:
        raise ValueError("The current editorial overlay supports at most three lines; shorten the visual plan.")
    source_credit = scene["_credit"]
    overlay = EditorialScene(title=visual["title"], kicker=visual.get("kicker", ""), lines=tuple(visual.get("lines", [])), credit=source_credit)
    span = scene["background"]
    background_key = fingerprint({"version": VERSION, "visual_style": VISUAL_STYLE_VERSION, "source": source_hash, "span": span, "canvas": [canvas.width, canvas.height, canvas.fps], "treatment": [treatment.mode, treatment.height_fraction]})
    background = shared_dir / f"background-{background_key[:24]}.mp4"
    background_record = background.with_suffix(".json")
    if not _cache_valid(background_record, background_key, background):
        # Only this bounded source interval enters the cache. Looping cannot
        # spill into other source statements beyond span.end.
        span_duration = span["end"] - span["start"]
        background_filter = build_background_filter(canvas, lower_third=treatment, darkness=.68, duration=span_duration)
        _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-filter_threads", "1", "-threads", "1",
              "-ss", str(span["start"]), "-i", video, "-t", str(span_duration), "-an", "-vf", background_filter,
              "-frames:v", str(max(1, round(span_duration*canvas.fps))), "-c:v", "libx264", "-preset", "veryfast",
              "-crf", "20", "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", background])
        _save_cache(background_record, background_key, background)
    timeline = overlay_timeline(overlay, duration)
    # One finite RGBA stream replaces multiple infinite full-resolution PNG
    # inputs. ffconcat decodes each stage once; fps repeats its frames in time.
    overlay_concat = scene_dir / "overlay-stages.ffconcat"
    stages = []
    total_frames = max(1, round(duration*canvas.fps))
    for index, step in enumerate(timeline):
        image = scene_dir / f"overlay-{step['stage']}.png"
        render_overlay_png(overlay, image, canvas=canvas, stage=step["stage"], font_path=font_path)
        start_frame = min(total_frames, math.ceil(step["start"]*canvas.fps-1e-8))
        end_frame = min(total_frames, math.ceil(step["end"]*canvas.fps-1e-8))
        if end_frame <= start_frame:
            continue
        stages.append((image, end_frame-start_frame))
    image_entries = _overlay_animation_entries(stages, canvas=canvas)
    overlay_concat.write_text("\n".join(image_entries)+"\n", encoding="utf-8")
    inputs = ["-threads", "1", "-stream_loop", "-1", "-i", str(background),
              "-threads", "1", "-f", "concat", "-safe", "0", "-i", str(overlay_concat)]
    filters = [f"[0:v]fps={canvas.fps},setpts=PTS-STARTPTS[base]",
               f"[1:v]fps={canvas.fps},setpts=PTS-STARTPTS,format=rgba[foreground]",
               "[base][foreground]overlay=0:0:eof_action=repeat:repeatlast=1[composed]",
               f"[composed]{caption_filter},format=yuv420p,setsar=1[outv]"]
    _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-filter_threads", "1", "-filter_complex_threads", "1", *inputs,
          "-filter_complex", ";".join(filters), "-map", "[outv]", "-an", *common, output])


def _scene_audio_filter(record, index, narrator_pitch_semitones):
    duration = record["duration"]
    # Plotquake's subtle, shared one-semitone treatment. Preserve the raw WAV,
    # source speakers and final timing; apply the same setting to every narrator.
    pitch = ""
    if record["kind"] == "narration" and narrator_pitch_semitones:
        ratio = 2 ** (narrator_pitch_semitones / 12)
        pitch = f"asetrate=24000*{ratio:.12f},aresample=48000,atempo={1/ratio:.12f},"
    return (
        f"[{index}:a]volume={record['gain']:.10f},{pitch}"
        f"afade=t=in:d=0.005,afade=t=out:st={max(0,record['content_duration']-.010):.6f}:d=0.010,"
        f"aresample=48000,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp:channel_layouts=stereo,"
        f"apad,atrim=duration={duration:.9f},asetpts=PTS-STARTPTS[a{index}]"
    )


def _master_audio(records, output, *, ffmpeg, narrator_pitch_semitones=DEFAULT_NARRATOR_PITCH_SEMITONES):
    inputs, filters, labels = [], [], []
    for index, record in enumerate(records):
        inputs.extend(["-i", str(record["audio"])])
        label = f"a{index}"
        filters.append(_scene_audio_filter(record, index, narrator_pitch_semitones))
        labels.append(f"[{label}]")
    filters.append("".join(labels) + f"concat=n={len(records)}:v=0:a=1[master]")
    _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(filters),
          "-map", "[master]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", output])


def _probe_output(output, *, ffmpeg, ffprobe):
    executable = shutil.which(str(ffprobe)) or (str(ffprobe) if Path(ffprobe).is_file() else None)
    if executable:
        return json.loads(_run([executable, "-v", "error", "-show_streams", "-show_format", "-of", "json", output]).stdout)
    # Local preview hosts may ship only ffmpeg/OpenCV. No network/install is
    # necessary when an approved voice bundle already supplies the WAVs.
    import re
    import cv2
    handle = cv2.VideoCapture(str(output))
    try:
        if not handle.isOpened():
            raise RuntimeError("OpenCV could not open the final MP4.")
        width, height = int(handle.get(cv2.CAP_PROP_FRAME_WIDTH)), int(handle.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps, frames = handle.get(cv2.CAP_PROP_FPS), handle.get(cv2.CAP_PROP_FRAME_COUNT)
        duration = frames / fps if fps else 0
    finally:
        handle.release()
    metadata = subprocess.run([str(ffmpeg), "-hide_banner", "-i", str(output)], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    return {"streams": [{"codec_type": "video", "codec_name": "h264" if re.search(r"Video:\s*h264\b", metadata) else "unknown", "width": width, "height": height},
                        {"codec_type": "audio", "codec_name": "aac" if re.search(r"Audio:\s*aac\b", metadata) else "unknown"}],
            "format": {"duration": duration}, "probe_method": "OpenCV geometry/duration plus ffmpeg codec metadata"}


def render_editorial_cut(video, transcript, plan, output, *, work_dir, aspect="9:16", lower_third=None,
                         voice_dir=None, font_dir=None, ffmpeg="ffmpeg", ffprobe="ffprobe", width=None,
                         fps=30, asr_model="base", allow_synthesis=True, delivery_overrides=None,
                         target_active_dbfs=-18.0, peak_ceiling=.95,
                         narrator_pitch_semitones=DEFAULT_NARRATOR_PITCH_SEMITONES):
    """Return {video,srt,capa,report}; output is the final MP4 file path."""
    from .editorial_visuals import Canvas, VISUAL_STYLE_VERSION
    video, transcript, output = Path(video).resolve(), Path(transcript).resolve(), Path(output).resolve()
    work = Path(work_dir).resolve()
    if output in (video, transcript) or output.suffix.lower() != ".mp4":
        raise ValueError("Final output must be a different .mp4 file.")
    if not video.is_file() or not transcript.is_file():
        raise FileNotFoundError("Source video/transcript unavailable.")
    if not math.isfinite(target_active_dbfs) or not -40 <= target_active_dbfs <= -10 or not 0 < peak_ceiling <= .99:
        raise ValueError("Invalid speech master target/peak ceiling.")
    if isinstance(narrator_pitch_semitones, bool) or not isinstance(narrator_pitch_semitones, (int, float)) or not math.isfinite(narrator_pitch_semitones) or not -3 <= narrator_pitch_semitones <= 3:
        raise ValueError("Invalid shared narrator pitch setting.")
    normalized = normalize_editorial_plan(_json(plan) if isinstance(plan, (str, Path)) else plan)
    source_words = captions.carregar_palavras(transcript)
    validate_source_ranges(normalized, source_words)
    treatment = lower_third or LowerThird()
    canvas = Canvas.for_format(aspect, width=width, fps=fps)
    work.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    shared = work / "shared"
    shared.mkdir(exist_ok=True)
    voice_dir = Path(voice_dir).resolve() if voice_dir else work / "voice"
    font_path, font_name = _font(font_dir)
    source_hash, font_hash = file_sha256(video), file_sha256(font_path)
    with _tool_path(ffmpeg, ffprobe):
        manifest, voices, aligned = _ensure_voice_bundle(normalized, voice_dir, allow_synthesis=allow_synthesis,
                                                        delivery_overrides=delivery_overrides, asr_model=asr_model)
        timeline = build_timeline(normalized, {key: item["duration"] for key, item in voices.items()}, fps=fps)
        voice_stats = {key: _wave_stats(item["path"]) for key, item in voices.items()}
        combined_rms = math.sqrt(sum(item["active_energy"] for item in voice_stats.values()) / sum(item["active_windows"] for item in voice_stats.values()))
        voice_gain = min(10 ** (target_active_dbfs/20) / combined_rms, peak_ceiling / max(item["peak"] for item in voice_stats.values()))
        achieved_target = combined_rms * voice_gain
        credit = "Fonte: " + normalized["source"]["label"] + (" | " + normalized["source"]["date"] if normalized["source"]["date"] else "")
        records, global_cues = [], []
        for scene, timing in zip(normalized["scenes"], timeline):
            scene_dir = work / aspect.replace(":", "x") / scene["id"]
            scene_dir.mkdir(parents=True, exist_ok=True)
            if scene["kind"] == "narration":
                info = voices[scene["id"]]
                audio, words, gain = info["path"], info["words"], voice_gain
                voice_key = {"duration": info["duration"], "words": words}
            else:
                audio = shared / f"source-audio-{fingerprint({'source':source_hash,'start':scene['start'],'end':scene['end']})[:24]}.wav"
                audio_key = fingerprint({"source": source_hash, "span": [scene["start"], scene["end"]], "format": "pcm16-mono24k"})
                if not _cache_valid(audio.with_suffix(".json"), audio_key, audio):
                    _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", str(scene["start"]), "-t", str(scene["end"]-scene["start"]), "-i", video, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", audio])
                    _save_cache(audio.with_suffix(".json"), audio_key, audio)
                stats = _wave_stats(audio)
                gain = min(achieved_target / stats["active_rms"], peak_ceiling / max(stats["peak"], 1e-12))
                words = captions.palavras_do_corte(source_words, scene["start"], scene["end"])
                if not words:
                    raise ValueError(f"Source clip has no caption words: {scene['id']}")
                voice_key = None
            ass, cues = _caption_assets(words, scene_dir, canvas=canvas, font_path=font_path, font_name=font_name,
                                        duration=timing["content_duration"], credit=credit if scene["kind"] == "clip" else "")
            augmented = dict(scene, _credit=credit)
            key = scene_fingerprint(augmented, source_hash=source_hash, canvas=[canvas.width, canvas.height, fps],
                                    lower_third=[treatment.mode, treatment.height_fraction], words=words, voice=voice_key, font_hash=font_hash)
            silent = scene_dir / "scene-video.mp4"
            cache_record = scene_dir / "scene-cache.json"
            resumed = _cache_valid(cache_record, key, silent)
            if not resumed:
                _encode_silent_scene(video, augmented, scene_dir, silent, canvas=canvas, treatment=treatment, ass=ass,
                                     font_path=font_path, duration=timing["duration"], ffmpeg=ffmpeg, shared_dir=shared, source_hash=source_hash)
                _save_cache(cache_record, key, silent)
            records.append({**timing, "video": str(silent), "audio": str(audio), "gain": gain,
                            "video_sha256": file_sha256(silent), "audio_sha256": file_sha256(audio),
                            "scene_fingerprint": key, "resumed_video": resumed})
            global_cues.extend({"start": cue["start"]+timing["start"], "end": cue["end"]+timing["start"], "text": cue["text"]} for cue in cues)
        total = timeline[-1]["end"]
        srt = output.with_suffix(".srt")
        srt.write_text("\n".join(line for index, cue in enumerate(global_cues, 1) for line in [str(index), f"{captions.srt_tempo(cue['start'])} --> {captions.srt_tempo(cue['end'])}", cue["text"], ""]), encoding="utf-8")
        final_key = fingerprint({"version": VERSION, "master_audio_version": MASTER_AUDIO_VERSION,
                                 "narrator_pitch_semitones": narrator_pitch_semitones,
                                 "records": [{key: row[key] for key in ("kind", "video_sha256", "audio_sha256", "gain", "duration")} for row in records]})
        final_record = output.with_suffix(".render-cache.json")
        final_resumed = _cache_valid(final_record, final_key, output)
        if not final_resumed:
            master = work / aspect.replace(":", "x") / "master.wav"
            _master_audio(records, master, ffmpeg=ffmpeg, narrator_pitch_semitones=narrator_pitch_semitones)
            concat = master.with_name("concat-video.txt")
            concat.write_text("".join("file '" + row["video"].replace("\\", "/").replace("'", "'\\''") + "'\n" for row in records), encoding="utf-8")
            _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", concat,
                  "-i", master, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                  "-ar", "48000", "-ac", "2", "-t", f"{total:.9f}", "-movflags", "+faststart", output])
            _save_cache(final_record, final_key, output)
        cover = output.with_name(output.stem + "_capa.jpg")
        _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", str(min(1.0, total/2)), "-i", output, "-frames:v", "1", "-q:v", "2", cover])
        probe = _probe_output(output, ffmpeg=ffmpeg, ffprobe=ffprobe)
        video_stream = next((stream for stream in probe["streams"] if stream.get("codec_type") == "video"), {})
        audio_stream = next((stream for stream in probe["streams"] if stream.get("codec_type") == "audio"), {})
        if video_stream.get("codec_name") != "h264" or audio_stream.get("codec_name") != "aac" or (video_stream.get("width"), video_stream.get("height")) != (canvas.width, canvas.height) or abs(float(probe["format"]["duration"])-total) > .15:
            raise RuntimeError("Final MP4 codec, geometry, or duration validation failed.")
        # The raw voice files must remain identical after all master operations.
        if any(file_sha256(item["path"]) != item["sha256"] for item in voices.values()):
            raise RuntimeError("Raw narration WAV changed during rendering.")
        report = {"version": VERSION, "status": "success", "video": str(output), "srt": str(srt), "capa": str(cover),
                  "aspect": aspect, "width": canvas.width, "height": canvas.height, "fps": fps, "duration_seconds": total,
                  "visual_style": VISUAL_STYLE_VERSION,
                  "source_sha256": source_hash, "plan_fingerprint": fingerprint(normalized), "video_sha256": file_sha256(output),
                  "voice_model": manifest["model"], "voice": manifest["voice"], "raw_voice_byte_identical": True,
                  "literal_tts_fidelity_passed": True, "caption_alignment_passed": True,
                  "voice_gain_common": voice_gain, "target_active_dbfs": target_active_dbfs,
                  "achieved_voice_active_dbfs": 20*math.log10(achieved_target), "peak_ceiling": peak_ceiling,
                  "master_audio_version": MASTER_AUDIO_VERSION,
                  "narrator_pitch_semitones": narrator_pitch_semitones,
                  "narrator_duration_preserved": True,
                  "source_speakers_pitch_unchanged": True,
                  "audio_processing": "Common narrator pitch with tempo compensation, gain and 5/10ms edge envelopes in separate master; raw WAVs untouched; no per-scene TTS loudnorm.",
                  "final_resumed": final_resumed, "scenes": records}
        report_file = output.with_suffix(".render-report.json")
        _write_json(report_file, report)
        return {"video": output, "srt": srt, "capa": cover, "report": report_file}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("video", "transcript", "plan", "output", "work-dir"):
        parser.add_argument("--"+name, required=True)
    parser.add_argument("--voice-dir")
    parser.add_argument("--font-dir")
    parser.add_argument("--aspect", choices=("9:16", "16:9"), default="9:16")
    parser.add_argument("--width", type=int)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--lower-third-mode", choices=("off", "crop", "cover"), default="off")
    parser.add_argument("--lower-third-height", type=float, default=0)
    parser.add_argument("--no-synthesis", action="store_true")
    args = parser.parse_args(argv)
    result = render_editorial_cut(args.video, args.transcript, args.plan, args.output, work_dir=args.work_dir,
        aspect=args.aspect, lower_third=LowerThird(args.lower_third_mode, args.lower_third_height),
        voice_dir=args.voice_dir, font_dir=args.font_dir, width=args.width, fps=args.fps,
        ffmpeg=args.ffmpeg, ffprobe=args.ffprobe, allow_synthesis=not args.no_synthesis)
    print(json.dumps({key: str(value) for key, value in result.items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
