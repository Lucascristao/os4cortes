from __future__ import annotations

import re
import subprocess
import urllib.request
from pathlib import Path

import cv2


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
    centro_x = w / 2
    alvo_x = centro_x
    alpha = 0.18

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

            if frame_idx % detectar_a_cada == 0:
                detector.setInputSize((w, h))
                _, faces = detector.detect(frame)

                if faces is not None and len(faces) > 0:
                    melhor = None
                    melhor_score = -1.0

                    for face in faces:
                        x, y, fw, fh = face[:4]
                        conf = float(face[-1])
                        area = float(fw * fh)
                        score = area * max(conf, 0.01)

                        if score > melhor_score:
                            melhor_score = score
                            melhor = face

                    if melhor is not None:
                        x, y, fw, fh = melhor[:4]
                        alvo_x = float(x + fw / 2)

            centro_x = centro_x * (1 - alpha) + alvo_x * alpha

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
