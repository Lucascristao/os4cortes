"""Manual local proof using the actual vertical and YouTube renderers.

Run with the render requirements and FFmpeg installed:
    python tests/render_lower_third_smoke.py --source clip.mp4 --height 0.30

The source must contain audio. This never uploads or publishes the results.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from processor.lower_third import LowerThird
from processor.tracking import render_cinematic_16x9, render_tracking_9x16


def ensure_ffmpeg(work: Path) -> None:
    if shutil.which("ffmpeg"):
        return
    import imageio_ffmpeg

    binary_dir = work / "ffmpeg-bin"
    binary_dir.mkdir(parents=True, exist_ok=True)
    target = binary_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if not target.exists():
        shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(), target)
    os.environ["PATH"] = str(binary_dir) + os.pathsep + os.environ.get("PATH", "")


def verify_video(path: Path, size: tuple[int, int], duration: float) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise AssertionError(f"Não foi possível abrir {path.name}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    count = 0
    dimensions = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        dimensions = (frame.shape[1], frame.shape[0])
        if dimensions != size:
            raise AssertionError(f"Dimensões incorretas em {path.name}: {dimensions}")
        count += 1
    cap.release()
    actual_duration = count / fps if fps else 0
    if not count or abs(actual_duration - duration) > max(0.15, 2 / fps):
        raise AssertionError(f"Duração incorreta em {path.name}: {actual_duration:.3f}s")
    audio = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
         "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
        capture_output=True,
    )
    if audio.returncode:
        raise AssertionError(f"Áudio ausente ou inválido em {path.name}: {audio.stderr.decode(errors='replace')}")
    samples = np.frombuffer(audio.stdout, dtype=np.float32)
    audio_duration = len(samples) / 16000
    rms = float(np.sqrt(np.mean(samples ** 2))) if len(samples) else 0.0
    if abs(audio_duration - duration) > 0.15 or not np.isfinite(rms) or rms <= 0.000001:
        raise AssertionError(f"Áudio truncado ou silencioso em {path.name}: {audio_duration:.3f}s, RMS={rms}")
    return {"file": path.name, "width": dimensions[0], "height": dimensions[1],
            "fps": fps, "frames": count, "duration": round(actual_duration, 3),
            "audio": True, "audio_duration": round(audio_duration, 3),
            "audio_rms": round(rms, 6), "bytes": path.stat().st_size}


def frame_at(path: Path, timestamp: float) -> Image.Image:
    cap = cv2.VideoCapture(str(path))
    cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError(f"Não foi possível extrair o quadro de {path.name}")
    return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))


def contact_sheet(out: Path, timestamp: float, height_fraction: float, suffix: str) -> None:
    canvas = Image.new("RGB", (1440, 1020), "#141414")
    draw = ImageDraw.Draw(canvas)
    font_file = Path("C:/Windows/Fonts/arial.ttf")
    font = ImageFont.truetype(str(font_file), 24) if font_file.exists() else ImageFont.load_default(size=24)
    small = ImageFont.truetype(str(font_file), 19) if font_file.exists() else ImageFont.load_default(size=19)
    draw.text((24, 14), f"Teste de tarja | altura na origem: {height_fraction:.0%} | quadro: {timestamp:.1f}s", font=font, fill="white")
    modes = (("original", "Sem tratamento"), ("faixa_preta", "Cobrir com faixa preta"),
             ("reenquadrado", "Remover e reenquadrar"))
    for column, (mode, title) in enumerate(modes):
        x = column * 480
        draw.text((x + 16, 55), title, font=font, fill="#ffe600")
        draw.text((x + 16, 90), "Vertical 9:16", font=small, fill="white")
        vertical = frame_at(out / f"vertical_{mode}.mp4", timestamp)
        vertical.thumbnail((288, 512), Image.Resampling.LANCZOS)
        canvas.paste(vertical, (x + (480 - vertical.width) // 2, 120))
        draw.text((x + 16, 660), "YouTube 16:9", font=small, fill="white")
        horizontal = frame_at(out / f"youtube_{mode}.mp4", timestamp)
        horizontal.thumbnail((464, 261), Image.Resampling.LANCZOS)
        canvas.paste(horizontal, (x + (480 - horizontal.width) // 2, 700))
    draw.text((24, 985), "Mesmo trecho e áudio nos dois formatos. Prova local; sem publicação.", font=small, fill="#c8c8c8")
    canvas.save(out / f"comparativo{suffix}.jpg", quality=94)


def main(args) -> None:
    source = args.source.resolve()
    out = args.output.resolve()
    work = args.workdir.resolve()
    if not source.is_file():
        raise ValueError("Arquivo de origem não encontrado.")
    if args.duration <= 0 or args.start < 0:
        raise ValueError("Início e duração inválidos.")
    # Validate before doing any expensive processing.
    LowerThird("cover", args.height)
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    ensure_ffmpeg(work)
    results = []
    formats = (("vertical", render_tracking_9x16, (1080, 1920)),
               ("youtube", render_cinematic_16x9, (1920, 1080)))
    for name, renderer, size in formats:
        for mode, label in (("off", "original"), ("cover", "faixa_preta"), ("crop", "reenquadrado")):
            destination = out / f"{name}_{label}.mp4"
            print(f"Renderizando {destination.name}...", flush=True)
            renderer(source, args.start, args.start + args.duration, destination,
                     work_dir=work, lower_third=LowerThird(mode, args.height if mode != "off" else 0.0))
            result = verify_video(destination, size, args.duration)
            result.update({"format": name, "mode": mode})
            results.append(result)
            print(f"OK: {destination.name}, {result['duration']}s, áudio preservado", flush=True)
    manifest = {"source": str(source), "start": args.start, "duration": args.duration,
                "height_fraction": args.height, "results": results}
    (out / "verificacao.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    contact_sheet(out, min(3.5, args.duration / 2), args.height, "")
    contact_sheet(out, min(0.8, args.duration / 4), args.height, "_zoom_inicial")
    if args.duration >= 7.5:
        contact_sheet(out, args.duration - 0.5, args.height, "_final")
    print(f"Amostras e comparativos: {out}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--duration", type=float, default=8)
    parser.add_argument("--height", type=float, default=0.30)
    parser.add_argument("--output", type=Path, default=Path("output/lower-third-test"))
    parser.add_argument("--workdir", type=Path, default=Path(".render_work"))
    args = parser.parse_args()
    main(args)
