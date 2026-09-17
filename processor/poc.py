from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

from .captions import CaptionStyle, carregar_palavras, criar_legendas_corte, escrever_post
from .download import baixar_youtube
from .drive import uploader_por_env
from .render_batch import ajustar_inicio_sem_silencio
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


def progresso(stage: str, overall: float, detail: str = "") -> None:
    extra = f"|detail={detail}" if detail else ""
    print(f"OS4_PROGRESS|stage={stage}|overall={overall:.1f}{extra}", flush=True)


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

    progresso("preparando", 2, "Preparando ambiente")
    print("[1/6] Baixando vídeo...")
    video = baixar_youtube(
        args.url,
        work,
        cookies_path=cookies,
        altura_maxima=1080,
    )
    progresso("download", 12, "Vídeo baixado")

    duracao = ffprobe_duration(video)
    if inicio < 0 or fim > duracao + 1:
        raise ValueError(
            f"Intervalo inválido: {inicio:.1f}s → {fim:.1f}s; vídeo tem {duracao:.1f}s."
        )

    print("[2/6] Extraindo áudio...")
    audio = extrair_audio(video, work / "audio.wav")
    progresso("audio", 15, f"Áudio preparado ({duracao:.1f}s)")

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

    palavras_globais = carregar_palavras(transcricao_json)
    inicio_efetivo = ajustar_inicio_sem_silencio(palavras_globais, inicio, fim)

    progresso("tracking", 58, "Iniciando enquadramento 9:16")
    print("[4/6] Renderizando tracking 9:16...")
    render_tracking_9x16(
        video,
        inicio_efetivo,
        fim,
        video_corte,
        work_dir=work,
    )
    progresso("tracking", 78, "Tracking 9:16 concluído")

    print("[5/6] Gerando legenda Archivo Black + SRT...")
    progresso("legendas", 80, "Gerando legendas")
    srt_path, video_legenda, capa_path = criar_legendas_corte(
        transcricao_json,
        video_corte,
        inicio_efetivo,
        fim,
        titulo=args.titulo,
        style=CaptionStyle(),
    )

    post_path = escrever_post(
        out / f"corte_01_{titulo_arquivo}_post.txt",
        args.titulo,
        args.legenda_post,
        args.hashtags,
    )

    shutil.copy2(transcricao_txt, out / "transcricao_para_chatgpt.txt")
    progresso("legendas", 90, "Vídeo legendado e arquivos auxiliares prontos")

    print("[6/6] Salvando resultados...")
    progresso("drive", 92, "Salvando no Google Drive")
    uploader = uploader_por_env()

    arquivos = [
        video_corte,
        video_legenda,
        srt_path,
        post_path,
        out / "transcricao_para_chatgpt.txt",
    ]
    if capa_path and capa_path.exists():
        arquivos.append(capa_path)

    if uploader is not None:
        total_arquivos = len(arquivos)
        for i, arquivo in enumerate(arquivos, start=1):
            file_id = uploader.upload(arquivo)
            percentual = 92 + (i / total_arquivos) * 8
            progresso("drive", percentual, f"Salvo {i}/{total_arquivos}: {arquivo.name}")
            print(f"Drive: {arquivo.name} -> {file_id}")
    else:
        print(
            "Google Drive não configurado; os arquivos permanecerão no runner "
            "e poderão ser coletados pelo artifact do workflow."
        )

    print("RESULTADOS:")
    for arquivo in arquivos:
        print(f"- {arquivo}")

    progresso("concluido", 100, "Processamento concluído")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
