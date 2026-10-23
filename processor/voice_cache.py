"""Lossless, session-scoped Drive checkpoints of approved original narration."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import tempfile
import wave
import zipfile

from .editorial_voice import fingerprint, prepare_voice_jobs

VERSION = "os4-raw-voice-checkpoint-v1"
MAX_FILES = 260
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_JSON_BYTES = 8 * 1024 * 1024
SAFE_SCENE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}\Z")
SIDECAR_FIELDS = frozenset(("engine", "model", "voice", "voice_treatment", "fallback_reason",
    "voice_policy_version", "voice_policy_fingerprint", "speech_profile_fingerprint", "speech_endpoint",
    "narration_sha256", "audio_sha256", "duration_seconds", "output_transcription",
    "output_transcription_similarity", "scene_direction_fingerprint", "output_fidelity"))


class VoiceCacheError(RuntimeError):
    pass


def _sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path):
    path = Path(path)
    if path.stat().st_size > MAX_JSON_BYTES:
        raise VoiceCacheError("Metadados do áudio excedem o limite permitido.")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise VoiceCacheError("Metadados de narração inválidos.")
    return value


def voice_cache_identity(plan, voice_dir):
    worker, jobs, expected = prepare_voice_jobs(plan, output_dir=voice_dir)
    if len(jobs) * 2 + 3 > MAX_FILES or any(not SAFE_SCENE.fullmatch(job["scene_id"]) for job in jobs):
        raise VoiceCacheError("Quantidade ou IDs das cenas incompatíveis com o checkpoint de voz.")
    identity = {field: expected[field] for field in (
        "version", "engine", "model", "voice", "voice_policy_fingerprint",
        "speech_profile_fingerprint", "global_direction_fingerprint")}
    identity["scenes"] = [{"id": job["scene_id"], "narration_sha256": job["narration_hash"],
                           "scene_direction_fingerprint": job["direction_fingerprint"]} for job in jobs]
    return fingerprint({"checkpoint_version": VERSION, "voice": identity}), worker, jobs, expected


def _approved_jobs(plan, root, *, required_ids=None):
    key, worker, jobs, expected = voice_cache_identity(plan, root)
    accepted = []
    for job in jobs:
        audio = job["output_file"]
        if not audio.exists() and not audio.with_suffix(".tts.json").exists():
            continue
        duration = worker.cached_duration(
            audio, job["narration_hash"], expected["model"], expected["voice"], worker.NO_VOICE_TREATMENT,
            expected["speech_profile_fingerprint"], narration=job["narration"],
            pronunciations=job["direction"].get("pronunciations", {}),
            direction_fingerprint=job["direction_fingerprint"],
        )
        if duration is None:
            if required_ids is not None and job["scene_id"] in required_ids:
                raise VoiceCacheError(f"Áudio restaurado reprovado nos gates de texto/voz/política: {job['scene_id']}")
            continue
        sidecar = _read_json(audio.with_suffix(".tts.json"))
        with wave.open(str(audio), "rb") as wav:
            untouched = (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) == (1, 2, 24000, "NONE")
        if not untouched or sidecar.get("output_fidelity", {}).get("passed") is not True:
            if required_ids is not None and job["scene_id"] in required_ids:
                raise VoiceCacheError(f"WAV original/fidelidade reprovado: {job['scene_id']}")
            continue
        sidecar = {key: value for key, value in sidecar.items() if key in SIDECAR_FIELDS}
        sidecar["output_fidelity"] = worker.evaluate_transcription(job["narration"], sidecar["output_transcription"],
            job["direction"].get("pronunciations", {}), worker.MINIMUM_TRANSCRIPTION_SIMILARITY)
        accepted.append((job, duration, sidecar))
    if required_ids is not None and {job["scene_id"] for job, _, _ in accepted} != set(required_ids):
        raise VoiceCacheError("O checkpoint não contém todas as cenas de voz declaradas.")
    return key, jobs, expected, accepted


def _safe_manifest(expected, accepted, complete):
    # Rebuild from current public voice policy. Never copy diagnostics, environment,
    # local paths, credentials, or unrelated files from a runner into the archive.
    omitted = {"credential_present", "sdk_installed", "source_plan_fingerprint"}
    manifest = {key: copy.deepcopy(value) for key, value in expected.items() if key not in omitted}
    manifest["status"] = "success" if complete else "failed"
    scenes = {job["scene_id"]: (job, duration, sidecar) for job, duration, sidecar in accepted}
    for row in manifest["scenes"]:
        if row["id"] in scenes:
            _, duration, sidecar = scenes[row["id"]]
            row.update(duration_seconds=duration, audio_sha256=sidecar["audio_sha256"],
                       output_transcription=sidecar["output_transcription"],
                       output_fidelity=sidecar["output_fidelity"], cache_validated=True)
    manifest["total_duration_seconds"] = sum(duration for _, duration, _ in accepted)
    return manifest


def _write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")


def _safe_alignment(value):
    fields = {"version", "status", "asr_engine", "asr_package_version", "asr_model", "device", "compute_type",
              "language", "word_timestamps", "initial_prompt", "canonical_text_preserved",
              "minimum_required_coverage", "tts_fidelity_required_separately"}
    result = {key: item for key, item in value.items() if key in fields}
    result["scenes"] = []
    for scene in value.get("scenes", []):
        row = {key: item for key, item in scene.items() if key in {"id", "file", "audio_sha256", "narration_sha256",
               "duration_seconds", "narration", "asr_text", "asr_language", "coverage"}}
        row["palavras"] = [{key: item for key, item in word.items() if key in {"texto", "inicio", "fim", "timing_source", "estimated"}}
                           for word in scene.get("palavras", [])]
        row["diagnostics"] = {key: item for key, item in scene.get("diagnostics", {}).items()
                              if key in {"passed", "direct_coverage", "unresolved_word_count", "timing_sources"}}
        result["scenes"].append(row)
    return result


def build_voice_archive(plan, voice_dir, destination):
    root, destination = Path(voice_dir).resolve(), Path(destination)
    key, jobs, expected, accepted = _approved_jobs(plan, root)
    if not accepted:
        return None
    complete = len(accepted) == len(jobs)
    with tempfile.TemporaryDirectory(prefix="voice-bundle-", dir=destination.parent) as temporary:
        staged = Path(temporary)
        manifest = _safe_manifest(expected, accepted, complete)
        _write_json(staged / "narration-manifest.json", manifest)
        for job, _, sidecar in accepted:
            shutil.copyfile(job["output_file"], staged / job["output_file"].name)
            _write_json(staged / job["output_file"].with_suffix(".tts.json").name, sidecar)
        if complete:
            # The existing full gate remains authoritative, not our checksum index.
            from .editorial_renderer import validate_voice_bundle
            validate_voice_bundle(plan, staged, require_alignment=False)
            alignment = root / "aligned-words.json"
            if alignment.is_file():
                try:
                    _write_json(staged / alignment.name, _safe_alignment(_read_json(alignment)))
                    validate_voice_bundle(plan, staged, require_alignment=True)
                except (OSError, ValueError, KeyError, TypeError):
                    # Save approved raw WAVs even if ASR/alignment was interrupted.
                    (staged / alignment.name).unlink(missing_ok=True)
        files = [{"name": path.name, "size": path.stat().st_size, "sha256": _sha(path)}
                 for path in sorted(staged.iterdir())]
        if sum(row["size"] for row in files) > MAX_TOTAL_BYTES or any(row["size"] > MAX_FILE_BYTES for row in files):
            raise VoiceCacheError("Checkpoint de voz excede o tamanho permitido.")
        _write_json(staged / "checkpoint.json", {"version": VERSION, "key": key,
                    "accepted_scene_ids": [job["scene_id"] for job, _, _ in accepted],
                    "complete": complete, "files": files})
        # Stored PCM is byte-identical; no lossy encoding or derived masters.
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
            for path in sorted(staged.iterdir()):
                entry = zipfile.ZipInfo(path.name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_STORED
                entry.external_attr = (stat.S_IFREG | 0o600) << 16
                with path.open("rb") as source, archive.open(entry, "w") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
    return {"key": key, "acceptedCount": len(accepted), "complete": complete, "sha256": _sha(destination)}


def restore_voice_archive(plan, archive_path, voice_dir):
    archive_path, root = Path(archive_path), Path(voice_dir).resolve()
    key, _, jobs, _ = voice_cache_identity(plan, root)
    allowed = {"checkpoint.json", "narration-manifest.json", "aligned-words.json"}
    allowed.update(job["output_file"].name for job in jobs)
    allowed.update(job["output_file"].with_suffix(".tts.json").name for job in jobs)
    if archive_path.stat().st_size > MAX_TOTAL_BYTES:
        raise VoiceCacheError("Arquivo de vozes excede o limite permitido.")
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="voice-restore-", dir=root.parent) as temporary:
        staged = Path(temporary)
        try:
            with zipfile.ZipFile(archive_path) as archive:
                members = archive.infolist()
                names = [item.filename for item in members]
                if len(members) > MAX_FILES or len(names) != len(set(names)) or not set(names) <= allowed:
                    raise VoiceCacheError("Conteúdo inesperado no checkpoint de voz.")
                if sum(item.file_size for item in members) > MAX_TOTAL_BYTES:
                    raise VoiceCacheError("Expansão do checkpoint de voz excede o limite permitido.")
                for item in members:
                    limit = MAX_JSON_BYTES if item.filename.endswith(".json") else MAX_FILE_BYTES
                    if item.is_dir() or item.file_size > limit or item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16):
                        raise VoiceCacheError("Entrada insegura no checkpoint de voz.")
                    if item.file_size > max(item.compress_size, 1) * 1000:
                        raise VoiceCacheError("Compressão excessiva no checkpoint de voz.")
                    target = staged / item.filename
                    # Allowed filenames are basenames generated from validated scene IDs.
                    with archive.open(item) as source, target.open("wb") as output:
                        shutil.copyfileobj(source, output, length=1024 * 1024)
            checkpoint = _read_json(staged / "checkpoint.json")
            if checkpoint.get("version") != VERSION or checkpoint.get("key") != key:
                raise VoiceCacheError("Checkpoint pertence a outro roteiro, voz ou política de narração.")
            files = checkpoint.get("files", [])
            if not isinstance(files, list) or {row.get("name") for row in files} != set(names) - {"checkpoint.json"} or len(files) != len(names) - 1:
                raise VoiceCacheError("Índice de integridade do checkpoint inválido.")
            for row in files:
                path = staged / row["name"]
                if row.get("size") != path.stat().st_size or row.get("sha256") != _sha(path):
                    raise VoiceCacheError("Checksum do checkpoint de voz não confere.")
            accepted_ids = checkpoint.get("accepted_scene_ids")
            if not isinstance(accepted_ids, list) or not accepted_ids or len(accepted_ids) != len(set(accepted_ids)):
                raise VoiceCacheError("Lista de cenas do checkpoint inválida.")
            _approved_jobs(plan, staged, required_ids=accepted_ids)
            complete = set(accepted_ids) == {job["scene_id"] for job in jobs}
            if checkpoint.get("complete") is not complete:
                raise VoiceCacheError("Estado do checkpoint não corresponde às cenas preservadas.")
            if complete:
                from .editorial_renderer import validate_voice_bundle
                validate_voice_bundle(plan, staged, require_alignment="aligned-words.json" in names)
            else:
                # A partial manifest must never claim the full bundle is renderable.
                manifest = _read_json(staged / "narration-manifest.json")
                if manifest.get("status") != "failed" or "aligned-words.json" in names:
                    raise VoiceCacheError("Checkpoint parcial declara uma aprovação incompleta.")
            root.mkdir(parents=True, exist_ok=True)
            for path in staged.iterdir():
                if path.name != "checkpoint.json":
                    shutil.copyfile(path, root / path.name)
            return {"key": key, "acceptedCount": len(accepted_ids), "complete": complete}
        except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
            if isinstance(exc, VoiceCacheError):
                raise
            raise VoiceCacheError(f"Checkpoint de voz inválido: {exc}") from exc


class SessionVoiceCache:
    def __init__(self, uploader, folder_id, plan, voice_dir):
        self.uploader, self.folder_id, self.plan = uploader, folder_id, plan
        self.voice_dir = Path(voice_dir).resolve()
        self.key = voice_cache_identity(plan, voice_dir)[0]
        self.name = f"_os4_vozes_{self.key}.zip"
        self.last_saved_sha = None

    def restore(self):
        file_id = self.uploader.find_file_by_name(self.name, folder_id=self.folder_id)
        if file_id is None:
            return None
        self.voice_dir.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="voice-download-", dir=self.voice_dir.parent) as temporary:
            path = Path(temporary) / self.name
            self.uploader.download(file_id, path)
            result = restore_voice_archive(self.plan, path, self.voice_dir)
            self.last_saved_sha = _sha(path)
            return result

    def checkpoint(self, _voice_dir=None):
        self.voice_dir.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="voice-upload-", dir=self.voice_dir.parent) as temporary:
            path = Path(temporary) / self.name
            result = build_voice_archive(self.plan, self.voice_dir, path)
            if result is None or result["sha256"] == self.last_saved_sha:
                return result
            try:
                self.uploader.upsert(path, self.name, folder_id=self.folder_id)
            except Exception as exc:
                raise VoiceCacheError(f"Falha ao preservar os áudios originais no Drive: {exc}") from exc
            self.last_saved_sha = result["sha256"]
            return result
