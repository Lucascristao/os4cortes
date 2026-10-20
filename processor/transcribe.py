from __future__ import annotations

import json
import subprocess
from pathlib import Path

from faster_whisper import WhisperModel

from .progress import emit


DEFAULT_INITIAL_PROMPT = (
    "Transmissão em português do Brasil, canal OS4 de Direita. "
    "Comentários e análises sobre política, economia, Congresso Nacional, STF, governo, leis e notícias do Brasil. "
    "Pontuação formal, vírgulas e acentuação corretas."
)


def extrair_audio(video_path: str | Path, audio_path: str | Path) -> Path:
    video_path = Path(video_path)
    audio_path = Path(audio_path)
    audio_path.parent.mkdir(parents=True, exist_ok=True)

    # Filtro de áudio para clareza vocal: corta sub-graves (<80Hz) que causam estalos e rumble,
    # corta frequências acima de 7.6kHz (ruído/chiado), e aplica speechnorm para equilibrar
    # a intensidade de falas fracas/distantes sem estourar o sinal.
    cmd_filtrado = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-af", "highpass=f=80,lowpass=f=7600,speechnorm=e=4:r=0.0001:l=1",
        "-c:a", "pcm_s16le",
        str(audio_path),
    ]
    try:
        subprocess.run(
            cmd_filtrado,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        # Fallback sem filtros caso a versão do ffmpeg não suporte speechnorm
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
    modelo: str = "large-v3-turbo",
    idioma: str = "pt",
    device: str = "cpu",
    compute_type: str = "int8",
    initial_prompt: str | None = None,
) -> tuple[Path, Path, list[dict]]:
    pasta_saida = Path(pasta_saida)
    pasta_saida.mkdir(parents=True, exist_ok=True)

    json_path = pasta_saida / "transcricao.json"
    txt_path = pasta_saida / "transcricao_para_chatgpt.txt"

    emit("carregando_whisper", 15.0, f"Carregando modelo de transcrição ({modelo})", stage_percent=0)
    try:
        model = WhisperModel(
            modelo,
            device=device,
            compute_type=compute_type,
        )
    except Exception as exc:
        print(f"Aviso ao carregar {modelo}: {exc}. Usando fallback 'small'...")
        model = WhisperModel(
            "small",
            device=device,
            compute_type=compute_type,
        )

    prompt = initial_prompt or DEFAULT_INITIAL_PROMPT
    segments, info = model.transcribe(
        str(audio_path),
        language=idioma,
        vad_filter=True,
        word_timestamps=True,
        beam_size=5,
        initial_prompt=prompt,
        condition_on_previous_text=False,
    )

    total = max(float(getattr(info, "duration", 0) or 0), 0.0)
    emit(
        "transcricao",
        16.0,
        "Transcrevendo vídeo",
        stage_percent=0,
        current=0,
        total=total,
    )

    resultado: list[dict] = []
    ultimo_reporte = -30.0

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

        atual = float(seg.end)
        if total > 0 and (atual - ultimo_reporte >= 30 or atual >= total - 1):
            etapa = max(0.0, min(100.0, (atual / total) * 100.0))
            geral = 16.0 + (etapa * 0.39)
            emit(
                "transcricao",
                geral,
                "Transcrevendo vídeo",
                stage_percent=etapa,
                current=atual,
                total=total,
            )
            ultimo_reporte = atual

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
    emit(
        "transcricao",
        55.0,
        "Transcrição concluída",
        stage_percent=100,
        current=total,
        total=total,
    )

    return json_path, txt_path, resultado
