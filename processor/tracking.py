from __future__ import annotations
import math
import re
import subprocess
import urllib.request
from pathlib import Path

import cv2

from .framing import Face, StableFraming


def calcular_movimento_labial(
    frame, face_box, prev_mouths, w: int, h: int
) -> tuple[float, tuple[float, float, any, float] | None]:
    """Estima variação de movimento da boca para pontuar atividade de fala com suavização temporal."""
    fx, fy, fw, fh = face_box[:4]
    my1 = max(0, int(fy + 0.60 * fh))
    my2 = min(h, int(fy + 0.95 * fh))
    mx1 = max(0, int(fx + 0.20 * fw))
    mx2 = min(w, int(fx + 0.80 * fw))
    if my2 <= my1 or mx2 <= mx1:
        return 0.0, None

    mouth_roi = cv2.resize(
        cv2.cvtColor(frame[my1:my2, mx1:mx2], cv2.COLOR_BGR2GRAY), (24, 16)
    )
    cx, cy = float(fx + fw / 2) / w, float(fy + fh / 2) / h
    best_score = 0.0

    for item in prev_mouths:
        pcx, pcy, p_roi = item[0], item[1], item[2]
        prev_score = item[3] if len(item) > 3 else 0.0
        if math.hypot(cx - pcx, cy - pcy) < 0.12 and p_roi is not None:
            diff = float(cv2.absdiff(mouth_roi, p_roi).mean())
            raw_score = min(1.0, max(0.0, (diff - 3.0) / 9.0))
            # Suavização temporal (EMA assimétrico): ataque rápido para fala e decaimento suave para pausas
            if raw_score >= prev_score:
                best_score = 0.60 * raw_score + 0.40 * prev_score
            else:
                best_score = 0.20 * raw_score + 0.80 * prev_score
            break

    return best_score, (cx, cy, mouth_roi, best_score)


def mudou_plano(previous, current) -> tuple[bool, bool]:
    """Detecta mudança de plano e se é um corte seco (hard cut)."""
    if previous is None:
        return True, True
    difference = float(cv2.absdiff(previous, current).mean())
    before = cv2.calcHist([previous], [0], None, [32], [0, 256])
    after = cv2.calcHist([current], [0], None, [32], [0, 256])
    correlation = cv2.compareHist(before, after, cv2.HISTCMP_CORREL)
    corte_seco = difference > 65.0 or (difference > 40.0 and correlation < 0.40)
    mudou = corte_seco or (difference > 32.0 and correlation < 0.65)
    return mudou, corte_seco


YUNET_URL = (
    "https://media.githubusercontent.com/media/"
    "opencv/opencv_zoo/main/models/"
    "face_detection_yunet/"
    "face_detection_yunet_2026may.onnx"
)


def nome_seguro(texto: str, limite: int = 60) -> str:
    texto = re.sub(r"[^A-Za-z0-9_-]+", "_", str(texto)).strip("_")
    return texto[:limite] or "corte"


def garantir_yunet(work_dir: str | Path) -> Path:
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    path = work_dir / "face_detection_yunet_2026may.onnx"

    if path.exists() and path.stat().st_size > 100_000:
        return path

    urllib.request.urlretrieve(YUNET_URL, path)

    if not path.exists() or path.stat().st_size < 100_000:
        raise RuntimeError("Falha ao obter o modelo YuNet.")

    return path


def render_tracking_9x16(
    video_origem: str | Path,
    inicio: float,
    fim: float,
    saida: str | Path,
    work_dir: str | Path,
    largura_saida: int = 1080,
    altura_saida: int = 1920,
    detectar_a_cada: int = 3,
) -> Path:
    video_origem = Path(video_origem)
    saida = Path(saida)
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    saida.parent.mkdir(parents=True, exist_ok=True)

    if fim <= inicio:
        raise ValueError("FIM precisa ser maior que INICIO.")

    duracao = fim - inicio
    stem = nome_seguro(saida.stem)
    segmento = work_dir / f"_segmento_{stem}.mp4"
    sem_audio = work_dir / f"_sem_audio_{stem}.mp4"

    # Extrai o segmento de corte na resolução nativa do vídeo de origem (sem forçar scale=-2:720)
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(inicio),
            "-t", str(duracao),
            "-i", str(video_origem),
            "-an",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            str(segmento),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    cap = cv2.VideoCapture(str(segmento))
    if not cap.isOpened():
        raise RuntimeError("OpenCV não conseguiu abrir o segmento de vídeo H.264.")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if w <= 0 or h <= 0:
        cap.release()
        raise RuntimeError("Dimensões inválidas no segmento de vídeo.")

    yunet = garantir_yunet(work_dir)

    # Resolução otimizada para detecção facial rápida com IA (máx 1280px de largura)
    det_w = min(1280, w)
    det_h = int(round(h * det_w / w))

    detector = cv2.FaceDetectorYN.create(
        str(yunet),
        "",
        (det_w, det_h),
        score_threshold=0.70,
        nms_threshold=0.30,
        top_k=5000,
    )

    crop_w = min(int(round(h * 9 / 16)), w)
    framing = StableFraming(crop_w / w)
    previous_scene = None
    previous_mouths: list[tuple[float, float, any]] = []

    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{largura_saida}x{altura_saida}",
        "-r", f"{fps:.6f}",
        "-i", "-",
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(sem_audio),
    ]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    frame_idx = 0

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            scene = cv2.resize(
                cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 36)
            )
            mudou, corte_seco = mudou_plano(previous_scene, scene)
            previous_scene = scene

            if mudou:
                framing.reset_shot(snap=corte_seco)
                previous_mouths = []

            if mudou or frame_idx % detectar_a_cada == 0:
                det_frame = (
                    cv2.resize(frame, (det_w, det_h))
                    if (det_w != w or det_h != h)
                    else frame
                )
                detector.setInputSize((det_w, det_h))
                _, faces = detector.detect(det_frame)

                detections: list[Face] = []
                current_mouths: list[tuple[float, float, any]] = []

                if faces is not None:
                    for f in faces:
                        score_fala, mouth_data = calcular_movimento_labial(
                            det_frame, f, previous_mouths, det_w, det_h
                        )
                        if mouth_data:
                            current_mouths.append(mouth_data)

                        detections.append(
                            Face(
                                float(f[0]) / det_w,
                                float(f[1]) / det_h,
                                float(f[2]) / det_w,
                                float(f[3]) / det_h,
                                float(f[-1]),
                                speaking_score=score_fala,
                            )
                        )
                    previous_mouths = current_mouths

                framing.observe(detections, frame_idx / fps)

            tempo_decorrido = frame_idx / fps
            centro_x = framing.position(tempo_decorrido) * w

            # Zoom Punch no Início: escala sutil de 1.08x nos primeiros 2.0s para retenção visual instantânea
            fator_zoom = 1.08 if tempo_decorrido < 2.0 else 1.0
            cur_crop_w = int(round(crop_w / fator_zoom))
            cur_crop_h = int(round(h / fator_zoom))

            x0 = int(round(centro_x - cur_crop_w / 2))
            x0 = max(0, min(w - cur_crop_w, x0))
            y0 = int(round((h - cur_crop_h) / 2))
            y0 = max(0, min(h - cur_crop_h, y0))

            crop = frame[y0:y0 + cur_crop_h, x0:x0 + cur_crop_w]

            vertical = cv2.resize(
                crop,
                (largura_saida, altura_saida),
                interpolation=cv2.INTER_LANCZOS4,
            )

            if proc.stdin is None:
                raise RuntimeError("Pipe de vídeo não disponível.")

            proc.stdin.write(vertical.tobytes())
            frame_idx += 1

    finally:
        cap.release()
        if proc.stdin:
            proc.stdin.close()
        proc.wait()

    if proc.returncode != 0 or not sem_audio.exists():
        raise RuntimeError("Falha ao gerar vídeo 9:16 sem áudio.")

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(sem_audio),
            "-ss", str(inicio),
            "-t", str(duracao),
            "-i", str(video_origem),
            "-map", "0:v:0",
            "-map", "1:a:0?",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "160k",
            "-shortest",
            "-movflags", "+faststart",
            str(saida),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    for temporario in (segmento, sem_audio):
        try:
            temporario.unlink(missing_ok=True)
        except Exception:
            pass

    return saida
