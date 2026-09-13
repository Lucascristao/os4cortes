from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload


SCOPES = ["https://www.googleapis.com/auth/drive.file"]
ProgressCallback = Callable[[float], None]


def credenciais_por_env() -> Credentials | None:
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    refresh_token = os.getenv("GOOGLE_REFRESH_TOKEN", "").strip()

    if not (client_id and client_secret and refresh_token):
        return None

    return Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=SCOPES,
    )


class DriveUploader:
    def __init__(self, folder_id: str):
        creds = credenciais_por_env()
        if creds is None:
            raise RuntimeError(
                "Credenciais do Google Drive ausentes. "
                "Defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN."
            )

        if not folder_id:
            raise ValueError("GOOGLE_DRIVE_FOLDER_ID não informado.")

        self.folder_id = folder_id
        self.service = build("drive", "v3", credentials=creds, cache_discovery=False)

    def criar_pasta(self, nome: str, parent_id: str | None = None) -> str:
        metadata = {
            "name": nome,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id or self.folder_id],
        }
        result = self.service.files().create(body=metadata, fields="id,name").execute()
        return str(result["id"])

    def upload(
        self,
        arquivo: str | Path,
        nome: str | None = None,
        *,
        folder_id: str | None = None,
        progress_cb: ProgressCallback | None = None,
    ) -> str:
        arquivo = Path(arquivo)
        if not arquivo.exists():
            raise FileNotFoundError(arquivo)

        metadata = {
            "name": nome or arquivo.name,
            "parents": [folder_id or self.folder_id],
        }
        media = MediaFileUpload(str(arquivo), resumable=True, chunksize=8 * 1024 * 1024)
        request = self.service.files().create(
            body=metadata,
            media_body=media,
            fields="id,name",
        )

        response = None
        last_report = -1.0
        while response is None:
            status, response = request.next_chunk()
            if status is not None and progress_cb is not None:
                progress = max(0.0, min(1.0, float(status.progress())))
                if progress >= 1.0 or progress - last_report >= 0.05:
                    progress_cb(progress)
                    last_report = progress

        if progress_cb is not None:
            progress_cb(1.0)

        return str(response["id"])

    def download(
        self,
        file_id: str,
        destino: str | Path,
        *,
        progress_cb: ProgressCallback | None = None,
    ) -> Path:
        destino = Path(destino)
        destino.parent.mkdir(parents=True, exist_ok=True)

        request = self.service.files().get_media(fileId=file_id)
        with destino.open("wb") as fh:
            downloader = MediaIoBaseDownload(fh, request, chunksize=8 * 1024 * 1024)
            done = False
            last_report = -1.0
            while not done:
                status, done = downloader.next_chunk()
                if status is not None and progress_cb is not None:
                    progress = max(0.0, min(1.0, float(status.progress())))
                    if done or progress - last_report >= 0.05:
                        progress_cb(progress)
                        last_report = progress

        if progress_cb is not None:
            progress_cb(1.0)
        return destino


def uploader_por_env() -> DriveUploader | None:
    folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID", "").strip()
    creds = credenciais_por_env()
    if not folder_id or creds is None:
        return None
    return DriveUploader(folder_id)
