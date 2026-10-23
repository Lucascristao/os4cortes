"""Keep an incomplete cut in its Drive session so only its cover needs retrying."""
from __future__ import annotations

import json
from pathlib import Path
import re

from .editorial_voice import fingerprint

VERSION = "os4-pending-cover-v1"
FILE_ID = re.compile(r"[a-zA-Z0-9_-]+\Z")


def pending_cut_key(cut, *, index, video_file_id, transcript_file_id, mode, lower_third, burn_captions):
    return fingerprint({"version": VERSION, "index": index, "video_file_id": video_file_id,
        "transcript_file_id": transcript_file_id, "mode": mode, "burn_captions": burn_captions,
        "lower_third": {"mode": lower_third.mode, "height_fraction": lower_third.height_fraction},
        "cut": {key: value for key, value in cut.items() if key != "cover"}})


class PendingCutStore:
    def __init__(self, uploader, folder_id, key, directory, sha256_file):
        self.uploader, self.folder_id, self.key = uploader, folder_id, key
        self.directory, self.sha256_file = Path(directory), sha256_file
        self.name = f"_os4_pendente_{key}.json"
        self.record = None

    def load(self):
        file_id = self.uploader.find_file_by_name(self.name, folder_id=self.folder_id)
        if file_id is None:
            return None
        self.directory.mkdir(parents=True, exist_ok=True)
        manifest = self.directory / self.name
        self.uploader.download(file_id, manifest)
        if manifest.stat().st_size > 1024 * 1024:
            raise ValueError("Manifesto da pendência de capa excede o limite permitido.")
        record = json.loads(manifest.read_text(encoding="utf-8"))
        if record.get("version") != VERSION or record.get("key") != self.key:
            raise ValueError("Pendência de capa pertence a outra montagem.")
        if record.get("status") == "resolved":
            return None
        files = record.get("files", {})
        if record.get("status") != "pending" or not isinstance(files, dict) or not {"video", "srt", "post"} <= set(files) or set(files) - {"video", "videoLegenda", "srt", "post"}:
            raise ValueError("Pendência de capa não contém um vídeo e seus metadados completos.")
        for key, row in files.items():
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not FILE_ID.fullmatch(row["id"]):
                raise ValueError("ID de arquivo inválido na pendência de capa.")
            name = row.get("name")
            if not isinstance(name, str) or not name or name != Path(name).name or "/" in name or "\\" in name or ":" in name:
                raise ValueError("Nome de arquivo inválido na pendência de capa.")
            destination = self.directory / name
            self.uploader.download(row["id"], destination)
            if destination.stat().st_size != row.get("size") or self.sha256_file(destination) != row.get("sha256"):
                raise ValueError("Vídeo/metadados da pendência de capa falharam na verificação de integridade.")
        self.record = record
        return record

    def _write(self, record):
        self.directory.mkdir(parents=True, exist_ok=True)
        destination = self.directory / self.name
        destination.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        self.uploader.upsert(destination, self.name, folder_id=self.folder_id)
        self.record = record

    def save(self, cut, assets, ids, reason):
        files = {key: {"id": ids[key], "name": Path(path).name, "size": Path(path).stat().st_size,
                       "sha256": self.sha256_file(path)} for key, path in assets if key != "capa"}
        self._write({"version": VERSION, "key": self.key, "status": "pending", "reason": reason,
                     "cut": cut, "files": files})

    def resolved(self, cut):
        record = dict(self.record)
        record.update(status="resolved", cut=cut)
        self._write(record)
