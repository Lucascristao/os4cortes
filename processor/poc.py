from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

from .captions import CaptionStyle, criar_legendas_corte, escrever_post
from .download import baixar_youtube
from .drive import uploader_por_env
from .tracking import render_tracking_9x16
from .transcribe import extrair_audio, transcrever
from .utils import nome_seguro, tempo_para_segundos


def ffprobe_duration(video_path: str | Path) -> float:
    r = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(r.stdout.strip())


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prova de conceito: um corte completo do OS4 Cortes."
    )
    parser.add_argument("--url", required=True, help="URL do YouTube.")
    parser.add_argument("--inicio", required=True, help="MM:SS ou segundos.")
    parser.add_argument("--fim", required=True, help="MM:SS ou segundos.")
    parser.add_argument("--titulo", default="Corte de teste")
    parser.add_argument("--legenda-post", default="")
    parser.add_argument("--hashtags", default="")
    parser.add_argument("--workdir", default=".work")
    parser.add_argument("--output", default="output")
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument("--idioma", default="pt")
    args = parser.parse_args()

    work = Path(args.workdir).resolve()
    out = Path(args.output).resolve()
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)

    inicio = tempo_para_segundos(args.inicio)
    fim = tempo_para_segundos(args.fim)

    if fim <= inicio:
        raise ValueError("fim precisa ser maior que início")

    cookies = os.getenv("YOUTUBE_COOKIES", "").strip() or None

    print("[1/6] Baixando vídeo...")
    video = baixar_youtube(
        args.url,
        work,
        cookies_path=cookies,
        altura_maxima=1080,
    )

    duracao = ffprobe_duration(video)
    if inicio < 0 or fim > duracao + 1:
        raise ValueError(
            f"Intervalo inválido: {inicio:.1f}s → {fim:.1f}s; vídeo tem {duracao:.1f}s."
        )

    print("[2/6] Extraindo áudio...")
    audio = extrair_audio(video, work / "audio.wav")

    print("[3/6] Transcrevendo com Faster-Whisper em CPU...")
    transcricao_json, transcricao_txt, _ = transcrever(
        audio,
        work,
        modelo=args.whisper_model,
        idioma=args.idioma,
        device="cpu",
        compute_type="int8",
    )

    titulo_arquivo = nome_seguro(args.titulo)
    video_corte = out / f"corte_01_{titulo_arquivo}.mp4"

    print("[4/6] Renderizando tracking 9:16...")
    render_tracking_9x16(
        video,
        inicio,
        fim,
        video_corte,
        work_dir=work,
    )

    print("[5/6] Gerando legenda Archivo Black + SRT...")
    srt_path, video_legenda = criar_legendas_corte(
        transcricao_json,
        video_corte,
        inicio,
        fim,
        style=CaptionStyle(),
    )

    post_path = escrever_post(
        out / f"corte_01_{titulo_arquivo}_post.txt",
        args.titulo,
        args.legenda_post,
        args.hashtags,
    )

    shutil.copy2(transcricao_txt, out / "transcricao_para_chatgpt.txt")

    print("[6/6] Salvando resultados...")
    uploader = uploader_por_env()

    arquivos = [
        video_corte,
        video_legenda,
        srt_path,
        post_path,
        out / "transcricao_para_chatgpt.txt",
    ]

    if uploader is not None:
        for arquivo in arquivos:
            file_id = uploader.upload(arquivo)
            print(f"Drive: {arquivo.name} -> {file_id}")
    else:
        print(
            "Google Drive não configurado; os arquivos permanecerão no runner "
            "e poderão ser coletados pelo artifact do workflow."
        )

    print("RESULTADOS:")
    for arquivo in arquivos:
        print(f"- {arquivo}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
