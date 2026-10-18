"""OS4 editorial narration using the local port of the ODE Gemini Live runtime.

The local voice_runtime package is the production default. --ode-root optionally
selects the original worker for compatibility/proof. Both require the pinned SDK,
ffprobe, and GEMINI_API_KEY in the environment. No credential files are loaded or
printed; the original ODE checkout is never modified.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys

if __package__:
    from .editorial_plan import normalize_editorial_plan
else:  # Portable cloud bundle: editorial_plan.py resides beside this file.
    from editorial_plan import normalize_editorial_plan


VOICE_ADAPTER_VERSION = "os4-editorial-live-adapter-v2-warm-baritone"
MASTER_PITCH_SEMITONES = -1.0
VOICE_TONE_REFERENCE = {
    "repository": "https://github.com/Lucascristao/Plotquake",
    "commit": "7a4e5f6d572cabd18138f9667ddc1109dd4e9db7",
    "implementation": "worker/synthesize_narration.py",
    "scope": "Warm chest resonance and a uniform derived-master tonal calibration; no music, effects, language or format copied.",
}
OS4_GLOBAL_DIRECTION = (
    "Direção OS4 Cortes: fale como numa conversa espontânea com uma pessoa, "
    "com presença, curiosidade e disposição para perguntar e entender. "
    "Use a própria voz Charon com ressonância de peito suave, quente e um "
    "registro confortável discretamente mais grave, sem forçar voz grossa. "
    "Comece nesse registro já na primeira palavra e mantenha-o ao retomar "
    "cada fala. Todas as cenas pertencem à mesma conversa: conserve timbre, "
    "cadência, energia e distância percebida do microfone, sem recomeçar "
    "cada cena como um anúncio novo. A curiosidade aparece na articulação "
    "e na intenção das perguntas, sem trocar de registro ou projetar a voz. "
    "Espontaneidade significa somente interpretação natural: leia literalmente "
    "o roteiro e nunca improvise ou acrescente falas. Evite cadência de repórter, "
    "voz de manchete, locução publicitária e dramatização. As perguntas devem "
    "soar como perguntas específicas dirigidas à pessoa que escuta, sem ironia "
    "insinuante. Conecte o raciocínio com fluidez e contraste proporcional ao "
    "sentido. Preserve a identidade Charon, o mesmo timbre, registro médio-grave confortável, "
    "volume e presença entre todas as cenas. Direção e cues não são texto falado."
)
V2_DELIVERY_OVERRIDES = {"abertura": "hook", "comentario": "explain", "fechamento": "question"}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _load_worker(ode_root=None):
    worker_dir = Path(ode_root).resolve() / "worker" if ode_root else Path(__file__).resolve().parent / "voice_runtime"
    required = [worker_dir / "synthesize_scenes.py", worker_dir / "tts_config.py", worker_dir / "voice-policy.json"]
    if not all(path.is_file() for path in required):
        raise RuntimeError("Runtime de voz não encontrado; inclua processor/voice_runtime ou selecione --ode-root para compatibilidade.")
    if ode_root:
        sys.path.insert(0, str(worker_dir))
        policy_module = "tts_config"
        worker_module = "synthesize_scenes"
    else:
        prefix = f"{__package__}.voice_runtime" if __package__ else "voice_runtime"
        policy_module = f"{prefix}.tts_config"
        worker_module = f"{prefix}.synthesize_scenes"
    policy = importlib.import_module(policy_module)
    if Path(policy.__file__).resolve() != (worker_dir / "tts_config.py").resolve():
        raise RuntimeError("Outro checkout ODE já foi importado neste processo; inicie um processo novo.")
    original = getattr(policy, "_os4_original_system_instruction", policy.live_system_instruction)
    policy._os4_original_system_instruction = original

    def os4_system_instruction(pronunciations=None):
        text = original(pronunciations)
        expected_identity = "Você é o narrador do canal O Dinheiro Explica."
        if expected_identity not in text:
            raise RuntimeError("Instrução de identidade ODE mudou; revisar adaptação antes de sintetizar.")
        return text.replace(expected_identity, "Você é o narrador do canal OS4 Cortes.") + " " + OS4_GLOBAL_DIRECTION

    # Original request/fidelity/cache functions use this configuration function.
    # Thus their policy fingerprint includes OS4 global direction automatically.
    policy.live_system_instruction = os4_system_instruction
    worker = importlib.import_module(worker_module)
    if Path(worker.__file__).resolve() != (worker_dir / "synthesize_scenes.py").resolve():
        raise RuntimeError("Worker ODE importado de outro checkout.")
    if worker.PRIMARY_TTS_MODEL != "gemini-3.8-live" or worker.DEFAULT_TTS_VOICE != "Charon":
        raise RuntimeError("Política ODE divergiu de gemini-3.8-live/Charon; não há troca automática de modelo ou voz.")
    return worker, worker_dir


def prepare_voice_jobs(raw_plan, *, output_dir, ode_root=None, delivery_overrides=None):
    """Normalize a plan and prepare literal jobs without credentials or network.

    Returns (worker, jobs, manifest). Any number of narration scenes permitted by
    normalize_editorial_plan is supported; source clips never become TTS jobs.
    Scene directions are validated by the unchanged ODE voice-policy functions.
    """
    normalized = normalize_editorial_plan(raw_plan)
    worker, worker_dir = _load_worker(ode_root)
    output = Path(output_dir).resolve()
    overrides = dict(delivery_overrides or {})
    narration_ids = {scene["id"] for scene in normalized["scenes"] if scene["kind"] == "narration"}
    if set(overrides) - narration_ids:
        raise ValueError("Override de voz cita cena que não é narração do plano.")
    global_direction_fingerprint = fingerprint({"version": VOICE_ADAPTER_VERSION, "channel": "OS4 Cortes", "system_instruction": worker.live_session_config("Charon")["system_instruction"]})
    # Also isolate the speech profile explicitly, in addition to ODE's voice
    # policy fingerprint, so old ODE/pilot caches cannot pass accidentally.
    speech_fingerprint = fingerprint({"ode_speech_profile": worker.project_speech_fingerprint({"speech": {"pronunciations": {}}}), "os4_global_direction": global_direction_fingerprint})
    jobs = []
    for position, scene in enumerate(normalized["scenes"]):
        if scene["kind"] != "narration":
            continue
        tts = copy.deepcopy(scene["tts"])
        if scene["id"] in overrides:
            tts["delivery"] = overrides[scene["id"]]
        ode_scene = {"id": scene["id"], "narration": scene["text"], "tts": tts}
        direction = worker.scene_voice_direction(ode_scene)
        worker.canonical_tokens(scene["text"], direction.get("pronunciations", {}))
        jobs.append({"scene": ode_scene, "scene_index": position, "scene_id": scene["id"], "narration": scene["text"], "narration_hash": hashlib.sha256(scene["text"].encode("utf-8")).hexdigest(), "output_file": output / f"{scene['id']}.wav", "direction": direction, "direction_fingerprint": worker.scene_direction_fingerprint(ode_scene)})
    if not jobs:
        raise ValueError("Plano sem cenas de narração.")
    manifest = {
        "version": VOICE_ADAPTER_VERSION, "status": "prepared",
        "source_plan_fingerprint": fingerprint(normalized), "source_text_unchanged": True,
        "engine": worker.ENGINE, "model": worker.PRIMARY_TTS_MODEL,
        "voice": "Charon", "presenter_name": "Roberto", "channel_identity": "OS4 Cortes",
        "global_direction": OS4_GLOBAL_DIRECTION,
        "global_direction_fingerprint": global_direction_fingerprint,
        "direction_overrides_in_memory": overrides,
        "ode_worker_sha256": hashlib.sha256((worker_dir / "synthesize_scenes.py").read_bytes()).hexdigest(),
        "runtime_source": "external-ode" if ode_root else "os4-local-port",
        "ode_checkout_required": bool(ode_root),
        "voice_policy_version": worker.VOICE_POLICY_VERSION,
        "voice_policy_fingerprint": worker.voice_policy_fingerprint(worker.PRIMARY_TTS_MODEL, "Charon"),
        "speech_profile_fingerprint": speech_fingerprint,
        "output_format": "pcm-s16le-24000-mono-wav", "effects_applied": False,
        "effects_scope": "raw-narration-wavs",
        "raw_audio_treatment": worker.NO_VOICE_TREATMENT,
        "raw_pitch_semitones": 0.0,
        "master_pitch_semitones": MASTER_PITCH_SEMITONES,
        "master_pitch_stage": "derived-narration-master-only",
        "master_pitch_applied": False,
        "master_pitch_instructions": "Apply uniformly once to derived narration only, preserving duration. Never pitch original source clips or overwrite raw WAVs; the compositor records the actual application.",
        "voice_tone_reference": VOICE_TONE_REFERENCE,
        "continuity": {
            "session_strategy": worker.VOICE_POLICY["live_runtime"]["session_strategy"],
            "same_voice_id": True, "shared_generation_profile": True,
            "cross_scene_websocket_reuse": False, "perfect_timbre_guaranteed": False,
        },
        "fallback_models": [], "sdk_required": worker.GOOGLE_GENAI_REQUIRED_VERSION,
        "sdk_installed": worker.installed_google_genai_version(),
        "credential_present": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
        "scenes": [{"id": job["scene_id"], "file": job["output_file"].name, "narration": job["narration"], "narration_sha256": job["narration_hash"], "scene_direction": job["direction"], "scene_direction_fingerprint": job["direction_fingerprint"]} for job in jobs],
    }
    return worker, jobs, manifest


def synthesize_editorial_voice(raw_plan, *, output_dir, ode_root=None, delivery_overrides=None, preflight_only=False, force_scene_ids=None):
    """Execute ODE synthesis/cache checks for the plan, or only local preflight."""
    output = Path(output_dir).resolve()
    worker, jobs, manifest = prepare_voice_jobs(raw_plan, ode_root=ode_root, output_dir=output, delivery_overrides=delivery_overrides)
    if force_scene_ids is None:
        force_scene_ids = []
    identifiers = {job["scene_id"] for job in jobs}
    if not isinstance(force_scene_ids, list) or any(not isinstance(identifier, str) or identifier not in identifiers for identifier in force_scene_ids):
        raise ValueError("force_scene_ids deve ser uma lista de IDs de narração presentes no plano.")
    if len(set(force_scene_ids)) != len(force_scene_ids):
        raise ValueError("force_scene_ids não pode conter IDs repetidos.")
    forced = set(force_scene_ids)
    manifest["forced_scene_ids"] = [job["scene_id"] for job in jobs if job["scene_id"] in forced]
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "narration-manifest.json"

    def save():
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if preflight_only:
        manifest["status"] = "ready" if manifest["credential_present"] and manifest["sdk_installed"] == manifest["sdk_required"] else "blocked-local-prerequisites"
        save()
        return manifest
    if not manifest["credential_present"]:
        manifest["status"] = "blocked-credential-unavailable"
        save()
        raise RuntimeError("GEMINI_API_KEY ausente. Configurar no ambiente do runner; nunca extrair o segredo do GitHub.")
    missing = []
    speech_fingerprint = manifest["speech_profile_fingerprint"]
    for job in jobs:
        if job["scene_id"] in forced:
            missing.append(job)
            continue
        duration = worker.cached_duration(job["output_file"], job["narration_hash"], worker.PRIMARY_TTS_MODEL, "Charon", worker.NO_VOICE_TREATMENT, speech_fingerprint, narration=job["narration"], pronunciations=job["direction"].get("pronunciations", {}), direction_fingerprint=job["direction_fingerprint"])
        if duration is None:
            missing.append(job)
    manifest["status"] = "synthesizing"
    save()
    try:
        asyncio.run(worker.synthesize_missing_jobs(missing, gemini_key=os.environ["GEMINI_API_KEY"].strip(), voice="Charon", pronunciations={}, speech_fingerprint=speech_fingerprint, diagnostics_path=output / "live-diagnostics.json"))
        for scene, job in zip(manifest["scenes"], jobs):
            sidecar = json.loads(job["output_file"].with_suffix(".tts.json").read_text(encoding="utf-8"))
            fidelity = worker.evaluate_transcription(job["narration"], sidecar["output_transcription"], job["direction"].get("pronunciations", {}), worker.MINIMUM_TRANSCRIPTION_SIMILARITY)
            if not fidelity["passed"]:
                raise RuntimeError(f"Fidelidade rejeitada após síntese: {job['scene_id']}")
            scene.update({"duration_seconds": worker.duration_seconds(job["output_file"]), "audio_sha256": worker.audio_sha256(job["output_file"]), "output_transcription": sidecar["output_transcription"], "output_fidelity": fidelity, "cache_validated": True})
        manifest["status"] = "success"
        manifest["total_duration_seconds"] = round(sum(scene["duration_seconds"] for scene in manifest["scenes"]), 3)
        save()
        return manifest
    except Exception:
        manifest["status"] = "failed"
        save()
        raise


def main(argv=None, *, delivery_overrides=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ode-root", help="Opcional: usar worker do checkout ODE para compatibilidade; padrão usa runtime OS4 local.")
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--v2-directions", action="store_true", help="Somente piloto v2: hook/explain/question por ID, sem alterar JSON.")
    args = parser.parse_args(argv)
    overrides = dict(delivery_overrides or {})
    if args.v2_directions:
        overrides.update(V2_DELIVERY_OVERRIDES)
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8-sig"))
    manifest = synthesize_editorial_voice(plan, ode_root=args.ode_root, output_dir=args.output_dir, delivery_overrides=overrides, preflight_only=args.preflight_only)
    print(json.dumps({"status": manifest["status"], "model": manifest["model"], "voice": manifest["voice"], "raw_pitch_semitones": manifest["raw_pitch_semitones"], "master_pitch_semitones": manifest["master_pitch_semitones"], "scenes": [{"id": scene["id"], "delivery": scene["scene_direction"].get("delivery"), "duration_seconds": scene.get("duration_seconds"), "fidelity_passed": scene.get("output_fidelity", {}).get("passed")} for scene in manifest["scenes"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
