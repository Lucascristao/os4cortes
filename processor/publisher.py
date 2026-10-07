"""Folder-scoped read authorization; never distributes Google/GitHub credentials."""
import hashlib
import hmac
import json
import os
from pathlib import Path
from urllib.parse import urlparse


def publisher_manifest(folder_id: str) -> dict:
    callback = urlparse(os.environ.get("OS4_PROGRESS_URL", ""))
    secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if callback.scheme != "https" or not callback.netloc or not secret:
        raise RuntimeError("Configuração do acompanhamento de cortes ausente.")
    token = hmac.new(secret.encode(), f"os4-publisher:{folder_id}".encode(), hashlib.sha256).hexdigest()
    return {"version": 1, "folderId": folder_id,
            "apiUrl": f"https://{callback.netloc}/.netlify/functions/publisher-folder",
            "token": token}


def save_publisher_manifest(uploader, folder_id: str, work: Path) -> None:
    target = work / "_os4_publicador.json"
    target.write_text(json.dumps(publisher_manifest(folder_id)), encoding="utf-8")
    uploader.upload(target, folder_id=folder_id)
