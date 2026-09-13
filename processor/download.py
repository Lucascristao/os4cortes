from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError


VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}


def achar_video(pasta: str | Path) -> Path | None:
    pasta = Path(pasta)
    candidatos = [
        p for p in pasta.glob("video.*")
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS
    ]
    return candidatos[0] if candidatos else None


def _opts_base(pasta_saida: Path, altura_maxima: int) -> dict:
    return {
        "format": f"bv*[height<={altura_maxima}]+ba/b[height<={altura_maxima}]/b",
        "outtmpl": str(pasta_saida / "video.%(ext)s"),
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": False,
        "no_warnings": False,
    }


def _baixar(url: str, opts: dict) -> None:
    with YoutubeDL(opts) as ydl:
        ydl.download([url])


def baixar_youtube(
    url: str,
    pasta_saida: str | Path,
    cookies_path: Optional[str | Path] = None,
    altura_maxima: int = 1080,
) -> Path:
    pasta_saida = Path(pasta_saida)
    pasta_saida.mkdir(parents=True, exist_ok=True)

    existente = achar_video(pasta_saida)
    if existente:
        return existente

    usar_pot = os.getenv("YTDLP_USE_POT", "").strip() == "1"
    cookie_file: Path | None = None
    if cookies_path:
        candidato = Path(cookies_path)
        if candidato.exists():
            cookie_file = candidato

    if usar_pot:
        print("YouTube: tentando acesso público com PO Token (sem cookies da conta)...", flush=True)
        opts_pot = _opts_base(pasta_saida, altura_maxima)
        opts_pot["extractor_args"] = {
            "youtube": {
                "player_client": ["mweb"],
            }
        }

        try:
            _baixar(url, opts_pot)
        except DownloadError:
            if cookie_file is None:
                raise

            print(
                "PO Token não concluiu o download. Tentando cookies como fallback...",
                flush=True,
            )
            opts_cookie = _opts_base(pasta_saida, altura_maxima)
            opts_cookie["cookiefile"] = str(cookie_file)
            _baixar(url, opts_cookie)
    else:
        opts = _opts_base(pasta_saida, altura_maxima)
        if cookie_file is not None:
            opts["cookiefile"] = str(cookie_file)
        _baixar(url, opts)

    video = achar_video(pasta_saida)
    if not video:
        raise RuntimeError("O yt-dlp terminou, mas nenhum vídeo foi encontrado.")

    return video
