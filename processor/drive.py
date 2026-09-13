from __future__ import annotations

import os
from pathlib import Path

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


SCOPES = ["https://www.googleapis.com/auth/drive.file"]


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

    def upload(self, arquivo: str | Path, nome: str | None = None) -> str:
        arquivo = Path(arquivo)
        if not arquivo.exists():
            raise FileNotFoundError(arquivo)

        metadata = {
            "name": nome or arquivo.name,
            "parents": [self.folder_id],
        }
        media = MediaFileUpload(str(arquivo), resumable=True)

        result = self.service.files().create(
            body=metadata,
            media_body=media,
            fields="id,name",
        ).execute()

        return str(result["id"])


def uploader_por_env() -> DriveUploader | None:
    folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID", "").strip()
    creds = credenciais_por_env()
    if not folder_id or creds is None:
        return None
    return DriveUploader(folder_id)
