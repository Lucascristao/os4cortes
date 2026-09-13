from __future__ import annotations

import json
import subprocess
from pathlib import Path

from faster_whisper import WhisperModel


def extrair_audio(video_path: str | Path, audio_path: str | Path) -> Path:
    video_path = Path(video_path)
    audio_path = Path(audio_path)
    audio_path.parent.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            str(audio_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return audio_path


def tempo_legivel(segundos: float) -> str:
    minutos = int(float(segundos) // 60)
    resto = float(segundos) % 60
    return f"{minutos:02d}:{resto:04.1f}"


def transcrever(
    audio_path: str | Path,
    pasta_saida: str | Path,
    modelo: str = "small",
    idioma: str = "pt",
    device: str = "cpu",
    compute_type: str = "int8",
) -> tuple[Path, Path, list[dict]]:
    pasta_saida = Path(pasta_saida)
    pasta_saida.mkdir(parents=True, exist_ok=True)

    json_path = pasta_saida / "transcricao.json"
    txt_path = pasta_saida / "transcricao_para_chatgpt.txt"

    model = WhisperModel(
        modelo,
        device=device,
        compute_type=compute_type,
    )

    segments, info = model.transcribe(
        str(audio_path),
        language=idioma,
        vad_filter=True,
        word_timestamps=True,
        beam_size=5,
    )

    resultado: list[dict] = []

    for seg in segments:
        item = {
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
            "text": seg.text.strip(),
            "words": [],
        }

        if seg.words:
            item["words"] = [
                {
                    "start": round(float(w.start or 0), 3),
                    "end": round(float(w.end or 0), 3),
                    "word": w.word,
                }
                for w in seg.words
            ]

        resultado.append(item)

    json_path.write_text(
        json.dumps(resultado, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    txt_path.write_text(
        "\n".join(
            f"[{tempo_legivel(x['start'])} → {tempo_legivel(x['end'])}] {x['text']}"
            for x in resultado
        ),
        encoding="utf-8",
    )

    print(f"Idioma detectado: {info.language} ({info.language_probability:.3f})")
    print(f"Segmentos: {len(resultado)}")

    return json_path, txt_path, resultado
