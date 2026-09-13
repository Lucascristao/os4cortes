from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

from .download import baixar_youtube
from .drive import uploader_por_env
from .progress import completed, emit, failed
from .transcribe import extrair_audio, transcrever


def ffprobe_duration(video_path: str | Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(result.stdout.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepara um vídeo do OS4 Cortes: download, transcrição e persistência no Drive.")
    parser.add_argument("--url", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--workdir", default=".work")
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument("--idioma", default="pt")
    args = parser.parse_args()

    work = Path(args.workdir).resolve()
    work.mkdir(parents=True, exist_ok=True)

    try:
        emit("preparando", 2.0, "Preparando ambiente")
        cookies = os.getenv("YOUTUBE_COOKIES", "").strip() or None

        emit("download", 4.0, "Baixando vídeo do YouTube")
        video = baixar_youtube(args.url, work, cookies_path=cookies, altura_maxima=1080)
        duracao = ffprobe_duration(video)
        emit("download", 12.0, "Vídeo baixado", current=duracao, total=duracao)

        emit("audio", 13.0, "Preparando áudio")
        audio = extrair_audio(video, work / "audio.wav")
        emit("audio", 15.0, f"Áudio preparado ({duracao:.1f}s)")

        transcricao_json, transcricao_txt, _ = transcrever(
            audio,
            work,
            modelo=args.whisper_model,
            idioma=args.idioma,
            device="cpu",
            compute_type="int8",
        )

        uploader = uploader_por_env()
        if uploader is None:
            raise RuntimeError("Google Drive não está configurado no GitHub Actions.")

        emit("drive", 57.0, "Criando pasta da sessão no Google Drive")
        folder_id = uploader.criar_pasta(f"sessao_{args.request_id}")

        def progresso_video(fracao: float) -> None:
            emit(
                "drive",
                58.0 + fracao * 34.0,
                "Salvando vídeo-base no Google Drive",
                stage_percent=fracao * 100.0,
            )

        video_file_id = uploader.upload(
            video,
            nome="video_base.mp4",
            folder_id=folder_id,
            progress_cb=progresso_video,
        )

        emit("drive", 93.0, "Salvando transcrição estruturada")
        transcript_json_file_id = uploader.upload(
            transcricao_json,
            nome="transcricao.json",
            folder_id=folder_id,
        )

        emit("drive", 96.0, "Salvando transcrição para o ChatGPT")
        transcript_txt_file_id = uploader.upload(
            transcricao_txt,
            nome="transcricao_para_chatgpt.txt",
            folder_id=folder_id,
        )

        texto_transcricao = transcricao_txt.read_text(encoding="utf-8")
        result = {
            "requestId": args.request_id,
            "folderId": folder_id,
            "videoFileId": video_file_id,
            "transcriptJsonFileId": transcript_json_file_id,
            "transcriptTxtFileId": transcript_txt_file_id,
            "duration": round(duracao, 3),
            "transcript": texto_transcricao,
            "driveFolderUrl": f"https://drive.google.com/drive/folders/{folder_id}",
        }

        completed("Transcrição pronta para escolher os cortes", result)
        return 0
    except Exception as exc:
        failed("Falha ao preparar o vídeo", str(exc))
        raise


if __name__ == "__main__":
    raise SystemExit(main())
