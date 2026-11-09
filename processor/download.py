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
        "format": f"bv*[vcodec^=avc][height<={altura_maxima}]+ba/bv*[height<={altura_maxima}]+ba/b[height<={altura_maxima}]/b",
        "outtmpl": str(pasta_saida / "video.%(ext)s"),
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": False,
        "no_warnings": False,
    }


def _baixar(url: str, opts: dict) -> None:
    with YoutubeDL(opts) as ydl:
        ydl.download([url])


def _erro_de_acesso(exc: DownloadError) -> bool:
    mensagem = str(exc).lower()
    return any(trecho in mensagem for trecho in (
        "http error 403", "sign in", "not a bot", "login_required",
        "cookies are no longer valid",
    ))


def _baixar_com_pot(
    url: str,
    pasta_saida: Path,
    altura_maxima: int,
    cookie_file: Path | None,
) -> None:
    # Tenta acesso público primeiro; só usa a conta se o YouTube o recusar.
    tentativas = [("mweb", None)]
    if cookie_file is not None:
        tentativas.append(("mweb", cookie_file))
    # O Safari também fornece HLS, uma alternativa às URLs HTTPS bloqueadas.
    tentativas.append(("web_safari", cookie_file))
    bloqueio_observado = False

    for indice, (cliente, cookies) in enumerate(tentativas, start=1):
        autenticacao = "com cookies" if cookies is not None else "sem cookies"
        print(
            f"YouTube: tentativa {indice}/{len(tentativas)}, "
            f"cliente {cliente} {autenticacao} e PO Token...",
            flush=True,
        )
        opts = _opts_base(pasta_saida, altura_maxima)
        opts["extractor_args"] = {
            "youtube": {"player_client": [cliente]},
            "youtubepot-bgutilhttp": {"base_url": ["http://127.0.0.1:4416"]},
        }
        # Testa os formatos candidatos para descartar URLs que retornam 403.
        opts["check_formats"] = True
        opts["verbose"] = True
        if cookies is not None:
            opts["cookiefile"] = str(cookies)
        try:
            _baixar(url, opts)
            return
        except DownloadError as exc:
            bloqueado = _erro_de_acesso(exc)
            formato_indisponivel = "requested format is not available" in str(exc).lower()
            if not (bloqueado or formato_indisponivel):
                raise
            bloqueio_observado = bloqueio_observado or bloqueado
            if indice < len(tentativas):
                print("YouTube recusou esta tentativa; tentando outra forma de acesso.", flush=True)
                continue
            # Erros de formato também podem ser uma restrição própria do vídeo.
            if not bloqueio_observado:
                raise
            orientacao = (
                "Atualize os cookies do YouTube no segredo YOUTUBE_COOKIES_B64 do GitHub e tente novamente."
                if cookie_file is not None else
                "Configure cookies do YouTube no segredo YOUTUBE_COOKIES_B64 do GitHub e tente novamente."
            )
            raise RuntimeError(
                f"O YouTube recusou o download após {len(tentativas)} tentativas. "
                f"{orientacao} Se persistir, o IP do executor pode estar bloqueado pelo YouTube."
            ) from exc


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
        if candidato.is_file():
            cookie_file = candidato

    if usar_pot:
        _baixar_com_pot(url, pasta_saida, altura_maxima, cookie_file)
    else:
        opts = _opts_base(pasta_saida, altura_maxima)
        if cookie_file is not None:
            opts["cookiefile"] = str(cookie_file)
        _baixar(url, opts)

    video = achar_video(pasta_saida)
    if not video:
        raise RuntimeError("O yt-dlp terminou, mas nenhum vídeo foi encontrado.")

    return video
