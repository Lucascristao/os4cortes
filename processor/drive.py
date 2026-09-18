from __future__ import annotations

import os
import time
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
        if not folder_id:
            raise ValueError("GOOGLE_DRIVE_FOLDER_ID não informado.")

        self.folder_id = folder_id
        self.service = self._criar_service()

    def _criar_service(self):
        creds = credenciais_por_env()
        if creds is None:
            raise RuntimeError(
                "Credenciais do Google Drive ausentes. "
                "Defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REFRESH_TOKEN."
            )
        return build("drive", "v3", credentials=creds, cache_discovery=False)

    def criar_pasta(self, nome: str, parent_id: str | None = None) -> str:
        metadata = {
            "name": nome,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id or self.folder_id],
        }
        max_tentativas = 3
        ultimo_erro = None
        for tentativa in range(1, max_tentativas + 1):
            try:
                result = self.service.files().create(body=metadata, fields="id,name").execute(num_retries=3)
                return str(result["id"])
            except Exception as exc:
                ultimo_erro = exc
                print(f"[DriveUploader] Erro ao criar pasta '{nome}' (tentativa {tentativa}/{max_tentativas}): {exc}", flush=True)
                if tentativa < max_tentativas:
                    time.sleep(1.5 * tentativa)
                    try:
                        self.service = self._criar_service()
                    except Exception:
                        pass
        raise RuntimeError(f"Falha ao criar pasta '{nome}' no Drive: {ultimo_erro}") from ultimo_erro

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

        nome_final = nome or arquivo.name
        max_tentativas = 5
        ultimo_erro = None

        for tentativa in range(1, max_tentativas + 1):
            try:
                metadata = {
                    "name": nome_final,
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
                    status, response = request.next_chunk(num_retries=5)
                    if status is not None and progress_cb is not None:
                        progress = max(0.0, min(1.0, float(status.progress())))
                        if progress >= 1.0 or progress - last_report >= 0.05:
                            progress_cb(progress)
                            last_report = progress

                if progress_cb is not None:
                    progress_cb(1.0)

                return str(response["id"])
            except Exception as exc:
                ultimo_erro = exc
                print(
                    f"[DriveUploader] Falha no upload de '{nome_final}' (tentativa {tentativa}/{max_tentativas}): "
                    f"{type(exc).__name__} - {exc}",
                    flush=True,
                )
                if tentativa < max_tentativas:
                    time.sleep(2.0 * tentativa)
                    try:
                        self.service = self._criar_service()
                    except Exception as e_recria:
                        print(f"[DriveUploader] Erro ao recriar conexão do Drive: {e_recria}", flush=True)

        raise RuntimeError(
            f"Falha ao enviar arquivo '{nome_final}' para o Drive após {max_tentativas} tentativas: {ultimo_erro}"
        ) from ultimo_erro

    def download(
        self,
        file_id: str,
        destino: str | Path,
        *,
        progress_cb: ProgressCallback | None = None,
    ) -> Path:
        destino = Path(destino)
        destino.parent.mkdir(parents=True, exist_ok=True)

        max_tentativas = 5
        ultimo_erro = None

        for tentativa in range(1, max_tentativas + 1):
            try:
                request = self.service.files().get_media(fileId=file_id)
                with destino.open("wb") as fh:
                    downloader = MediaIoBaseDownload(fh, request, chunksize=8 * 1024 * 1024)
                    done = False
                    last_report = -1.0
                    while not done:
                        status, done = downloader.next_chunk(num_retries=5)
                        if status is not None and progress_cb is not None:
                            progress = max(0.0, min(1.0, float(status.progress())))
                            if done or progress - last_report >= 0.05:
                                progress_cb(progress)
                                last_report = progress

                if progress_cb is not None:
                    progress_cb(1.0)
                return destino
            except Exception as exc:
                ultimo_erro = exc
                print(
                    f"[DriveUploader] Falha no download do arquivo {file_id} (tentativa {tentativa}/{max_tentativas}): "
                    f"{type(exc).__name__} - {exc}",
                    flush=True,
                )
                if tentativa < max_tentativas:
                    time.sleep(2.0 * tentativa)
                    try:
                        self.service = self._criar_service()
                    except Exception:
                        pass

        raise RuntimeError(
            f"Falha ao baixar arquivo {file_id} do Drive após {max_tentativas} tentativas: {ultimo_erro}"
        ) from ultimo_erro


def uploader_por_env() -> DriveUploader | None:
    folder_id = os.getenv("GOOGLE_DRIVE_FOLDER_ID", "").strip()
    creds = credenciais_por_env()
    if not folder_id or creds is None:
        return None
    return DriveUploader(folder_id)
