"""Replace existing Drive cover bytes without rendering video or synthesizing voice."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
from pathlib import Path

from . import drive
from .covers import TEMPLATE_IDS, normalize_cover, render_cover
from .lower_third import LowerThird


FILE_FIELDS = "id,name,mimeType,parents,trashed,md5Checksum,capabilities(canEdit)"
ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{10,200}\Z")


def _file_id(value, name):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ValueError(f"{name}: ID do Drive inválido.")
    return value


def validate_repairs(raw):
    """Validate the complete batch before any download, render or remote write."""
    if isinstance(raw, str):
        if len(raw) > 65536:
            raise ValueError("repairs_json excede 64 KiB.")
        raw = json.loads(raw)
    if not isinstance(raw, list) or not 1 <= len(raw) <= 20:
        raise ValueError("repairs_json deve conter de 1 a 20 capas.")
    result, ids = [], set()
    required = {"file_id", "aspect", "cover", "ranges"}
    allowed = required | {"source_label", "lower_third"}
    for item in raw:
        if not isinstance(item, dict) or not required <= item.keys() or item.keys() - allowed:
            raise ValueError("Reparo deve informar file_id, aspect, cover e ranges.")
        file_id = _file_id(item["file_id"], "file_id")
        if file_id in ids:
            raise ValueError("Um arquivo de capa não pode aparecer duas vezes.")
        ids.add(file_id)
        aspect = item["aspect"]
        if aspect not in ("9:16", "16:9"):
            raise ValueError("aspect deve ser 9:16 ou 16:9.")
        if not isinstance(item["cover"], dict) or item["cover"].get("template_id") not in TEMPLATE_IDS:
            raise ValueError("Reparos devem usar um dos três modelos ativos.")
        cover = normalize_cover(item["cover"], "", aspect)
        ranges = item["ranges"]
        if not isinstance(ranges, list) or not 1 <= len(ranges) <= 100:
            raise ValueError("ranges deve conter de 1 a 100 intervalos originais.")
        intervals = []
        for interval in ranges:
            if isinstance(interval, dict) and set(interval) == {"start", "end"}:
                start, end = interval["start"], interval["end"]
            elif isinstance(interval, list) and len(interval) == 2:
                start, end = interval
            else:
                raise ValueError("Intervalo deve ser [início, fim] em segundos.")
            if (type(start) not in (int, float) or type(end) not in (int, float)
                    or not math.isfinite(start) or not math.isfinite(end)
                    or start < 0 or end <= start):
                raise ValueError("Intervalo original inválido.")
            intervals.append((float(start), float(end)))
        label = item.get("source_label", "")
        if (not isinstance(label, str) or len(label) > 240
                or any(ord(char) < 32 for char in label)):
            raise ValueError("source_label deve ser texto simples de até 240 caracteres.")
        treatment = item.get("lower_third", {})
        if not isinstance(treatment, dict) or set(treatment) - {"mode", "height_fraction"}:
            raise ValueError("lower_third inválido.")
        lower_third = LowerThird(**treatment)
        result.append({"file_id": file_id, "aspect": aspect, "cover": cover,
                       "ranges": intervals, "source_label": label, "lower_third": lower_third})
    return result


def _metadata(service, file_id):
    return service.files().get(fileId=file_id, fields=FILE_FIELDS, supportsAllDrives=True).execute(num_retries=3)


def _check_member(metadata, file_id, folder_id):
    if (metadata.get("id") != file_id or metadata.get("trashed")
            or metadata.get("parents") != [folder_id]):
        raise ValueError(f"Arquivo {file_id} não pertence exclusivamente à pasta informada.")


def _check_cover(metadata, file_id, folder_id):
    _check_member(metadata, file_id, folder_id)
    if metadata.get("mimeType") != "image/jpeg" or not metadata.get("name", "").endswith("_capa.jpg"):
        raise ValueError(f"Arquivo {file_id} deve ser JPEG com nome terminado em _capa.jpg.")
    if metadata.get("capabilities", {}).get("canEdit") is not True:
        raise ValueError(f"A conta de produção não pode editar a capa {file_id}.")


def _download(service, file_id, output):
    request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    with output.open("wb") as stream:
        downloader = drive.MediaIoBaseDownload(stream, request, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            _, done = downloader.next_chunk(num_retries=5)


def _md5(path):
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def repair_covers(service, folder_id, video_file_id, repairs, work_dir, *, renderer=render_cover):
    """Preflight every target, prepare every image, then update media in place."""
    folder_id = _file_id(folder_id, "folder_id")
    video_file_id = _file_id(video_file_id, "video_file_id")
    repairs = validate_repairs(repairs)
    if video_file_id in {item["file_id"] for item in repairs}:
        raise ValueError("O vídeo original não pode ser um destino de capa.")
    folder = service.files().get(fileId=folder_id, fields="id,mimeType,trashed", supportsAllDrives=True).execute(num_retries=3)
    if folder.get("id") != folder_id or folder.get("mimeType") != "application/vnd.google-apps.folder" or folder.get("trashed"):
        raise ValueError("folder_id não identifica uma pasta ativa.")
    source = _metadata(service, video_file_id)
    _check_member(source, video_file_id, folder_id)
    if not source.get("mimeType", "").startswith("video/"):
        raise ValueError("video_file_id deve identificar um vídeo original.")
    originals = {}
    for item in repairs:
        file_id = item["file_id"]
        metadata = _metadata(service, file_id)
        _check_cover(metadata, file_id, folder_id)
        originals[file_id] = metadata

    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    source_path = work / "source-video.mp4"
    _download(service, video_file_id, source_path)
    prepared = []
    for item in repairs:
        output = work / f"{item['file_id']}_capa.jpg"
        report = renderer(source_path, item["ranges"], output, cover=item["cover"], aspect=item["aspect"],
                          source_label=item["source_label"], lower_third=item["lower_third"], work_dir=work / "cover-cache")
        prepared.append((item, output, report, _md5(output)))

    # Long downloads/scans must not overwrite an intervening manual replacement.
    for item in repairs:
        file_id = item["file_id"]
        current = _metadata(service, file_id)
        _check_cover(current, file_id, folder_id)
        previous = originals[file_id]
        if any(current.get(key) != previous.get(key) for key in ("name", "md5Checksum")):
            raise ValueError(f"A capa {file_id} mudou durante a preparação; nenhuma substituição foi iniciada.")

    results = []
    report_path = work / "repair-report.json"
    for item, output, report, md5 in prepared:
        file_id = item["file_id"]
        media = drive.MediaFileUpload(str(output), mimetype="image/jpeg", resumable=True)
        response = service.files().update(fileId=file_id, media_body=media, fields=FILE_FIELDS,
                                          supportsAllDrives=True).execute(num_retries=3)
        _check_cover(response, file_id, folder_id)
        if response.get("name") != originals[file_id]["name"] or response.get("md5Checksum") != md5:
            raise RuntimeError(f"Falha ao verificar conteúdo/metadata da capa {file_id} após envio.")
        result = {"file_id": file_id, "name": response["name"], "md5": md5,
                  "applied_template": report["applied_template"], "timestamp": report["selection"]["timestamp"],
                  "sha256": report["sha256"]}
        results.append(result)
        report_path.write_text(json.dumps({"repairs": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False), flush=True)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder-id", default=os.getenv("OS4_REPAIR_FOLDER_ID", ""))
    parser.add_argument("--video-file-id", default=os.getenv("OS4_REPAIR_VIDEO_FILE_ID", ""))
    parser.add_argument("--repairs-json", default=os.getenv("OS4_REPAIRS_JSON", ""))
    parser.add_argument("--work-dir", default=".cover-repair")
    args = parser.parse_args()
    # Reject malformed input before authentication or any remote operation.
    validate_repairs(args.repairs_json)
    credentials = drive.credenciais_por_env()
    if credentials is None or drive.build is None:
        raise RuntimeError("Credenciais/dependências do Google Drive ausentes.")
    service = drive.build("drive", "v3", credentials=credentials, cache_discovery=False)
    repair_covers(service, args.folder_id, args.video_file_id, args.repairs_json, args.work_dir)


if __name__ == "__main__":
    main()
