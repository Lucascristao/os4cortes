from __future__ import annotations

from pathlib import Path
from typing import Optional

from yt_dlp import YoutubeDL


VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}


def achar_video(pasta: str | Path) -> Path | None:
    pasta = Path(pasta)
    candidatos = [
        p for p in pasta.glob("video.*")
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS
    ]
    return candidatos[0] if candidatos else None


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

    opts = {
        "format": f"bv*[height<={altura_maxima}]+ba/b[height<={altura_maxima}]/b",
        "outtmpl": str(pasta_saida / "video.%(ext)s"),
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": False,
        "no_warnings": False,
    }

    if cookies_path:
        cookies_path = Path(cookies_path)
        if cookies_path.exists():
            opts["cookiefile"] = str(cookies_path)

    with YoutubeDL(opts) as ydl:
        ydl.download([url])

    video = achar_video(pasta_saida)
    if not video:
        raise RuntimeError("O yt-dlp terminou, mas nenhum vídeo foi encontrado.")

    return video
