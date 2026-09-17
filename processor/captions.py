from __future__ import annotations

import json
import re
import shutil
import subprocess
import urllib.request
from dataclasses import dataclass
from pathlib import Path


ARCHIVO_BLACK_URL = (
    "https://raw.githubusercontent.com/google/fonts/"
    "main/ofl/archivoblack/ArchivoBlack-Regular.ttf"
)
DEFAULT_FONT_DIR = Path.home() / ".local" / "share" / "fonts" / "cortai"


@dataclass
class CaptionStyle:
    font_name: str = "Archivo Black"
    font_size: int = 88
    margin_v: int = 330
    outline: int = 4
    shadow: int = 0
    max_words: int = 6
    max_chars: int = 34
    pause_cut: float = 0.5
    max_duration: float = 2.6
    line_chars: int = 21


def garantir_archivo_black(
    pasta_fontes: str | Path = DEFAULT_FONT_DIR,
) -> Path:
    pasta_fontes = Path(pasta_fontes).expanduser()
    pasta_fontes.mkdir(parents=True, exist_ok=True)
    font_path = pasta_fontes / "ArchivoBlack-Regular.ttf"

    if not font_path.exists() or font_path.stat().st_size < 50_000:
        urllib.request.urlretrieve(ARCHIVO_BLACK_URL, font_path)

    # fontconfig validates the family on Linux runners. Local Windows previews
    # use the same TTF through fontsdir, without changing installed system fonts.
    if not shutil.which("fc-scan"):
        from PIL import ImageFont
        if "Archivo Black" not in ImageFont.truetype(str(font_path), 20).getname()[0]:
            raise RuntimeError("O TTF baixado não foi reconhecido como Archivo Black.")
        return font_path

    scan = subprocess.run(
        ["fc-scan", "--format", "%{family}\n", str(font_path)],
        capture_output=True,
        text=True,
        check=True,
    )

    if "Archivo Black" not in scan.stdout:
        raise RuntimeError("O TTF baixado não foi reconhecido como Archivo Black.")

    subprocess.run(
        ["fc-cache", "-f", str(pasta_fontes)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    return font_path


def srt_tempo(segundos: float) -> str:
    total_ms = max(0, round(float(segundos) * 1000))
    total_seconds, ms = divmod(total_ms, 1000)
    hours, rest = divmod(total_seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}"



def ass_tempo(segundos: float) -> str:
    segundos = max(0.0, float(segundos))
    horas = int(segundos // 3600)
    minutos = int((segundos % 3600) // 60)
    resto = segundos % 60
    return f"{horas}:{minutos:02d}:{resto:05.2f}"


def escapar_ass(texto: str) -> str:
    return (
        str(texto)
        .replace("\\", r"\\")
        .replace("{", r"\{")
        .replace("}", r"\}")
    )


def juntar_palavras(palavras: list[dict]) -> str:
    texto = " ".join(p["texto"] for p in palavras)
    return re.sub(r"\s+([,.;:!?])", r"\1", texto).strip()


def carregar_palavras(transcricao_path: str | Path) -> list[dict]:
    transcricao = json.loads(Path(transcricao_path).read_text(encoding="utf-8"))
    palavras: list[dict] = []

    for seg in transcricao:
        words = seg.get("words") or []

        if words:
            for w in words:
                texto = str(w.get("word", "")).strip()
                if not texto:
                    continue

                inicio = float(w.get("start", seg.get("start", 0)) or 0)
                fim = float(w.get("end", seg.get("end", inicio)) or inicio)

                palavras.append(
                    {
                        "texto": texto,
                        "inicio": inicio,
                        "fim": max(fim, inicio + 0.03),
                    }
                )
        else:
            texto_seg = str(seg.get("text", "")).strip()
            tokens = texto_seg.split()

            if not tokens:
                continue

            s0 = float(seg.get("start", 0))
            s1 = float(seg.get("end", s0 + 0.1))
            passo = max(0.1, s1 - s0) / len(tokens)

            for idx, token in enumerate(tokens):
                palavras.append(
                    {
                        "texto": token,
                        "inicio": s0 + idx * passo,
                        "fim": s0 + (idx + 1) * passo,
                    }
                )

    palavras.sort(key=lambda x: x["inicio"])
    return palavras


def palavras_do_corte(
    palavras_globais: list[dict],
    inicio_corte: float,
    fim_corte: float,
) -> list[dict]:
    saida: list[dict] = []

    for p in palavras_globais:
        if p["fim"] <= inicio_corte:
            continue
        if p["inicio"] >= fim_corte:
            break

        inicio_rel = max(0.0, p["inicio"] - inicio_corte)
        fim_rel = min(fim_corte - inicio_corte, p["fim"] - inicio_corte)

        if fim_rel <= inicio_rel:
            continue

        saida.append(
            {
                "texto": p["texto"],
                "inicio": inicio_rel,
                "fim": fim_rel,
            }
        )

    return saida


# Small language-independent layout limits, with Portuguese/English connector
# hints. These are preferences, never reasons to drop or rewrite spoken words.
CONNECTORS = {"a", "o", "as", "os", "um", "uma", "de", "do", "da", "dos", "das",
              "em", "no", "na", "nos", "nas", "por", "para", "com", "e", "que",
              "the", "a", "an", "of", "to", "and", "with", "for", "in"}


def custo_fronteira(words: list[dict], index: int) -> float:
    previous = words[index - 1]["texto"].lower().strip()
    following = words[index]["texto"].lower().strip() if index < len(words) else ""
    if previous in {"dentro", "fora", "através", "junto", "apesar"} and following in {"de", "do", "da", "dos", "das"}:
        return 12
    if re.search(r"[.!?;:]$", previous):
        return -8
    if previous.endswith(","):
        return -4
    return 7 if previous in CONNECTORS else 0


def agrupar_palavras(palavras: list[dict], style: CaptionStyle) -> list[list[dict]]:
    grupos = []
    offset = 0
    while offset < len(palavras):
        remaining = palavras[offset:]
        count = 1
        while count < min(style.max_words, len(remaining)):
            previous, current = remaining[count - 1], remaining[count]
            if (current["inicio"] - previous["fim"] >= style.pause_cut
                    or re.search(r"[.!?]$", previous["texto"])
                    or len(juntar_palavras(remaining[:count + 1])) > style.max_chars
                    or current["fim"] - remaining[0]["inicio"] > style.max_duration):
                break
            count += 1
        # Prefer complete short phrases over a hard six-word cut ending in 'de'.
        if count >= 4:
            count = min(range(3, count + 1), key=lambda k:
                        custo_fronteira(remaining, k) + (count - k) * 1.5
                        + (4 if len(remaining) - k == 1 else 0))
        grupos.append(remaining[:count])
        offset += count
    return grupos


def melhor_quebra(palavras: list[dict], line_chars: int = 21) -> int:
    if len(juntar_palavras(palavras)) <= line_chars or len(palavras) <= 1:
        return len(palavras)
    def score(index):
        left = juntar_palavras(palavras[:index])
        right = juntar_palavras(palavras[index:])
        overflow = max(0, len(left) - line_chars) + max(0, len(right) - line_chars)
        return (overflow * 30 + abs(len(left) - len(right))
                + custo_fronteira(palavras, index)
                + (5 if min(index, len(palavras) - index) == 1 else 0))
    return min(range(1, len(palavras)), key=score)


def texto_ass_grupo(palavras: list[dict], indice_ativo: int, line_chars: int = 21) -> str:
    tokens: list[str] = []

    for i, p in enumerate(palavras):
        texto = escapar_ass(p["texto"])
        if i == indice_ativo:
            texto = r"{\c&H0000FFFF&\fscx108\fscy108\t(0,80,\fscx104\fscy104)}" + texto + r"{\c&H00FFFFFF&\fscx100\fscy100}"
        tokens.append(texto)

    corte = melhor_quebra(palavras, line_chars)

    if corte >= len(tokens):
        return " ".join(tokens)

    return " ".join(tokens[:corte]) + r"\N" + " ".join(tokens[corte:])


def texto_srt_grupo(grupo: list[dict], line_chars: int = 21) -> str:
    texto = juntar_palavras(grupo)
    tokens = texto.split()

    pseudo = [{"texto": t} for t in tokens]
    corte = melhor_quebra(pseudo, line_chars)

    if corte >= len(tokens):
        return texto

    return " ".join(tokens[:corte]) + "\n" + " ".join(tokens[corte:])


def gerar_capa_frame0(
    arquivo_video: str | Path,
    titulo: str,
    destino_capa: str | Path,
    pasta_fontes: str | Path = DEFAULT_FONT_DIR,
    tempo_frame: float = 2.0,
) -> Path:
    from PIL import Image, ImageDraw, ImageFont

    arquivo_video = Path(arquivo_video)
    destino_capa = Path(destino_capa)
    font_path = garantir_archivo_black(pasta_fontes)
    temp_frame = destino_capa.with_suffix(".temp_frame.jpg")

    # 1. Extrair frame estático com FFmpeg com seleção inteligente de nitidez
    if arquivo_video.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
        shutil.copy2(arquivo_video, temp_frame)
    else:
        # Avaliar múltiplos candidatos para selecionar o frame mais nítido (evitando olhos fechados e piscadas)
        candidatos_t = [
            max(0.5, float(tempo_frame)),
            max(0.5, float(tempo_frame) - 0.7),
            max(0.5, float(tempo_frame) + 0.7),
            max(0.5, float(tempo_frame) + 1.4),
        ]
        melhor_score = -1.0
        melhor_frame = None

        for idx, t_cand in enumerate(candidatos_t):
            cand_path = destino_capa.with_suffix(f".cand_{idx}.jpg")
            try:
                subprocess.run(
                    [
                        "ffmpeg", "-y",
                        "-ss", f"{t_cand:.2f}",
                        "-i", str(arquivo_video),
                        "-vframes", "1",
                        "-q:v", "2",
                        str(cand_path),
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except Exception:
                pass

            if cand_path.exists() and cand_path.stat().st_size > 1000:
                score = 10.0
                try:
                    import cv2
                    img_cv = cv2.imread(str(cand_path), cv2.IMREAD_GRAYSCALE)
                    if img_cv is not None:
                        score = float(cv2.Laplacian(img_cv, cv2.CV_64F).var())
                except Exception:
                    pass

                if score > melhor_score or melhor_frame is None:
                    if melhor_frame and melhor_frame.exists():
                        melhor_frame.unlink(missing_ok=True)
                    melhor_score = score
                    melhor_frame = cand_path
                else:
                    cand_path.unlink(missing_ok=True)

        if melhor_frame and melhor_frame.exists():
            shutil.move(str(melhor_frame), str(temp_frame))

    if not temp_frame.exists():
        Image.new("RGB", (1080, 1920), (24, 24, 28)).save(str(temp_frame))

    # 2. Composição gráfica 1080x1920 com Pillow
    img = Image.open(temp_frame).convert("RGBA")
    if img.size != (1080, 1920):
        img = img.resize((1080, 1920), Image.Resampling.LANCZOS)

    draw = ImageDraw.Draw(img)

    # 3. Quebra de linha do título do corte
    font_size = 64
    font_titulo = ImageFont.truetype(str(font_path), font_size)
    words = titulo.strip().split()
    lines = []
    curr = []
    for w in words:
        test = " ".join(curr + [w])
        bbox = font_titulo.getbbox(test)
        if bbox[2] - bbox[0] > 920 and curr:
            lines.append(" ".join(curr))
            curr = [w]
        else:
            curr.append(w)
    if curr:
        lines.append(" ".join(curr))

    if len(lines) > 3:
        font_size = 54
        font_titulo = ImageFont.truetype(str(font_path), font_size)
        lines = []
        curr = []
        for w in words:
            test = " ".join(curr + [w])
            bbox = font_titulo.getbbox(test)
            if bbox[2] - bbox[0] > 920 and curr:
                lines.append(" ".join(curr))
                curr = [w]
            else:
                curr.append(w)
        if curr:
            lines.append(" ".join(curr))

    line_h = int(font_size * 1.22)
    total_title_h = len(lines) * line_h

    # 4. Badge "OS4 CORTES" discreto posicionado na base logo acima do título
    # Grade segura: Instagram 1:1 é Y: 420-1500, TikTok 3:4 é Y: 240-1680.
    # Posicionamento na base: peito/mesa (Y=1140-1420), mantendo a cabeça/rosto 100% livres e em destaque.
    font_badge = ImageFont.truetype(str(font_path), 30)
    badge_text = "OS4 CORTES"
    bbox_b = font_badge.getbbox(badge_text)
    bw = bbox_b[2] - bbox_b[0]
    bh = bbox_b[3] - bbox_b[1]
    bx = (1080 - bw) // 2
    pad_x, pad_y = 22, 8
    badge_box_h = bh + (pad_y * 2)

    spacing_badge_title = 24
    total_block_h = badge_box_h + spacing_badge_title + total_title_h

    # Ancoragem na base segura (limite inferior em 1420, deixando margem antes do corte de 1500 do Instagram)
    by = 1420 - total_block_h
    by = max(1120, by)

    draw.rounded_rectangle(
        [bx - pad_x, by, bx + bw + pad_x, by + badge_box_h],
        radius=12,
        fill=(0, 0, 0, 210),
        outline=(255, 230, 0, 255),  # Amarelo elétrico
        width=2,
    )
    draw.text((bx, by + pad_y - bbox_b[1]), badge_text, font=font_badge, fill=(255, 255, 255, 255))

    # 5. Renderização do título com contorno sólido e sombra individual nos caracteres (sem tarja de fundo)
    start_y = by + badge_box_h + spacing_badge_title
    for idx, l in enumerate(lines):
        bbox = font_titulo.getbbox(l)
        lw = bbox[2] - bbox[0]
        lx = (1080 - lw) // 2
        ly = start_y + idx * line_h
        # Sombra projetada sutil
        draw.text((lx + 3, ly + 3), l, font=font_titulo, fill=(0, 0, 0, 220))
        # Texto nítido com contorno (stroke) preto de 4px para legibilidade perfeita sobre qualquer roupa/fundo
        draw.text(
            (lx, ly),
            l,
            font=font_titulo,
            fill=(255, 255, 255, 255),
            stroke_width=4,
            stroke_fill=(0, 0, 0, 255),
        )

    destino_capa.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(str(destino_capa), "JPEG", quality=95)
    temp_frame.unlink(missing_ok=True)
    return destino_capa


def criar_legendas_corte(
    transcricao_path: str | Path,
    arquivo_video: str | Path,
    inicio_corte: float,
    fim_corte: float,
    titulo: str = "",
    pasta_fontes: str | Path = DEFAULT_FONT_DIR,
    style: CaptionStyle | None = None,
    color_grading: bool = True,
    gerar_capa: bool = True,
) -> tuple[Path, Path, Path | None]:
    style = style or CaptionStyle()
    pasta_fontes = Path(pasta_fontes).expanduser()
    font_path = garantir_archivo_black(pasta_fontes)
    from PIL import ImageFont
    measured_font = ImageFont.truetype(str(font_path), style.font_size)

    arquivo_video = Path(arquivo_video)
    base = arquivo_video.with_suffix("")
    srt_path = Path(str(base) + ".srt")
    ass_path = Path(str(base) + ".ass")
    video_legenda = Path(str(base) + "_legenda.mp4")

    palavras_globais = carregar_palavras(transcricao_path)
    palavras = palavras_do_corte(
        palavras_globais,
        float(inicio_corte),
        float(fim_corte),
    )

    if not palavras:
        raise RuntimeError("Nenhuma palavra com timestamp encontrada para o corte.")

    grupos = agrupar_palavras(palavras, style)

    srt_linhas: list[str] = []

    for idx, grupo in enumerate(grupos, start=1):
        inicio = grupo[0]["inicio"]
        fim = grupo[-1]["fim"]
        srt_linhas.extend(
            [
                str(idx),
                f"{srt_tempo(inicio)} --> {srt_tempo(fim)}",
                texto_srt_grupo(grupo, style.line_chars),
                "",
            ]
        )

    srt_path.write_text("\n".join(srt_linhas), encoding="utf-8")

    ass_header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Clean,{style.font_name},{style.font_size},&H00FFFFFF,&H0000FFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,{style.outline},{style.shadow},2,70,70,{style.margin_v},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""

    eventos: list[str] = []

    for grupo in grupos:
        lines = texto_srt_grupo(grupo, style.line_chars).splitlines()
        measured_width = max(measured_font.getlength(line) for line in lines)
        group_size = min(style.font_size, int(style.font_size * 900 / max(1, measured_width)))
        for wi, palavra in enumerate(grupo):
            inicio = palavra["inicio"]
            if wi + 1 < len(grupo):
                fim = grupo[wi + 1]["inicio"]
            else:
                fim = palavra["fim"]

            fim = max(fim, inicio + 0.06)
            texto_evento = texto_ass_grupo(grupo, wi, style.line_chars)
            if group_size < style.font_size:
                texto_evento = r"{\fs" + str(group_size) + "}" + texto_evento

            eventos.append(
                "Dialogue: 0,"
                f"{ass_tempo(inicio)},"
                f"{ass_tempo(fim)},"
                "Clean,,0,0,0,,"
                f"{texto_evento}"
            )

    ass_path.write_text(
        ass_header + "\n".join(eventos) + "\n",
        encoding="utf-8",
    )

    def filter_path(path):
        return str(Path(path).resolve()).replace("\\", "/").replace(":", r"\:").replace("'", r"'\''")

    capa_path = None
    if gerar_capa and titulo.strip():
        try:
            caminho_capa = Path(str(base) + "_capa.jpg")
            duracao_corte = float(fim_corte) - float(inicio_corte)
            t_frame = min(2.0, max(0.5, duracao_corte / 2.0))
            capa_path = gerar_capa_frame0(
                arquivo_video=arquivo_video,
                titulo=titulo,
                destino_capa=caminho_capa,
                pasta_fontes=pasta_fontes,
                tempo_frame=t_frame,
            )
        except Exception as e:
            capa_path = None

    # Base de filtros: Color Grading Cinematográfico Médio + Legendas ASS
    # eq: contraste e saturação médios para pretos mais profundos e tons de pele ricos
    # unsharp: nitidez refinada para preservar textura de pele e cabelo após compressão
    filtros_base = []
    if color_grading:
        filtros_base.append("eq=contrast=1.12:saturation=1.14")
        filtros_base.append("unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.75")
    filtros_base.append(f"ass='{filter_path(ass_path)}':fontsdir='{filter_path(pasta_fontes)}'")

    chain_base = ",".join(filtros_base)

    duracao = max(1.0, float(fim_corte) - float(inicio_corte))
    st_fade = max(0.0, duracao - 0.4)
    audio_filter = f"loudnorm=I=-14:TP=-1.5:LRA=11,acompressor=threshold=-18dB:ratio=3:attack=15:release=100,afade=t=out:st={st_fade:.2f}:d=0.4"

    def tem_audio(caminho: str | Path) -> bool:
        try:
            res = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-select_streams", "a:0",
                    "-show_entries", "stream=codec_type",
                    "-of", "csv=p=0",
                    str(caminho),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            return bool(res.stdout.strip())
        except Exception:
            return True

    if capa_path and capa_path.exists():
        # Overlay do Frame 0 de Alto Impacto durante os primeiros 0.14s (~4 frames a 30fps)
        filtro_complex = (
            f"[0:v]{chain_base}[base];"
            f"[base][1:v]overlay=0:0:enable='between(t,0,0.14)'[outv]"
        )
        cmd = [
            "ffmpeg", "-y",
            "-i", str(arquivo_video),
            "-i", str(capa_path),
            "-filter_complex", filtro_complex,
            "-map", "[outv]",
        ]
        if tem_audio(arquivo_video):
            cmd.extend([
                "-map", "0:a:0",
                "-af", audio_filter,
                "-c:a", "aac",
                "-b:a", "192k",
            ])
        cmd.extend([
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-movflags", "+faststart",
            str(video_legenda),
        ])
    else:
        cmd = [
            "ffmpeg", "-y",
            "-i", str(arquivo_video),
            "-vf", chain_base,
        ]
        if tem_audio(arquivo_video):
            cmd.extend([
                "-af", audio_filter,
                "-c:a", "aac",
                "-b:a", "192k",
            ])
        cmd.extend([
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-movflags", "+faststart",
            str(video_legenda),
        ])

    subprocess.run(cmd, check=True)
    ass_path.unlink(missing_ok=True)
    return srt_path, video_legenda, capa_path


def escrever_post(
    destino: str | Path,
    titulo: str,
    legenda_post: str = "",
    hashtags: str = "",
) -> Path:
    destino = Path(destino)
    texto = titulo.strip()

    if legenda_post.strip():
        texto += "\n\n" + legenda_post.strip()

    # Assinatura oficial @os4.cortes
    assinatura = "Siga @os4.cortes para mais insights diários sobre negócios e liderança."
    if "@os4.cortes" not in texto:
        texto += "\n\n" + assinatura

    if hashtags.strip():
        tags = hashtags.strip()
        tags = re.sub(r"#os4cortes\b", "", tags, flags=re.IGNORECASE)
        tags = re.sub(r"#os4\b", "", tags, flags=re.IGNORECASE)
        tags = " ".join(tags.split())
        if tags:
            texto += "\n\n" + tags

    destino.write_text(texto.strip() + "\n", encoding="utf-8")
    return destino
