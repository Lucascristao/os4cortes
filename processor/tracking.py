from __future__ import annotations

import re
import subprocess
import urllib.request
from pathlib import Path

import cv2

from .framing import Face, StableFraming


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
    proxy = work_dir / f"_proxy_{stem}.mp4"
    sem_audio = work_dir / f"_sem_audio_{stem}.mp4"

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(inicio),
            "-t", str(duracao),
            "-i", str(video_origem),
            "-an",
            "-vf", "scale=-2:720",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "21",
            "-pix_fmt", "yuv420p",
            str(proxy),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    cap = cv2.VideoCapture(str(proxy))
    if not cap.isOpened():
        raise RuntimeError("OpenCV não conseguiu abrir o proxy H.264.")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if w <= 0 or h <= 0:
        cap.release()
        raise RuntimeError("Dimensões inválidas no proxy.")

    yunet = garantir_yunet(work_dir)

    detector = cv2.FaceDetectorYN.create(
        str(yunet),
        "",
        (w, h),
        score_threshold=0.70,
        nms_threshold=0.30,
        top_k=5000,
    )

    crop_w = min(int(round(h * 9 / 16)), w)
    framing = StableFraming(crop_w / w)
    previous_scene = None

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
        "-crf", "20",
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

            if mudou or frame_idx % detectar_a_cada == 0:
                detector.setInputSize((w, h))
                _, faces = detector.detect(frame)

                detections = (
                    []
                    if faces is None
                    else [
                        Face(
                            float(f[0]) / w,
                            float(f[1]) / h,
                            float(f[2]) / w,
                            float(f[3]) / h,
                            float(f[-1]),
                        )
                        for f in faces
                    ]
                )
                framing.observe(detections, frame_idx / fps)

            centro_x = framing.position(frame_idx / fps) * w

            x0 = int(round(centro_x - crop_w / 2))
            x0 = max(0, min(w - crop_w, x0))
            crop = frame[:, x0:x0 + crop_w]

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

    for temporario in (proxy, sem_audio):
        try:
            temporario.unlink(missing_ok=True)
        except Exception:
            pass

    return saida
