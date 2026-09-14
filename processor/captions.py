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


def criar_legendas_corte(
    transcricao_path: str | Path,
    arquivo_video: str | Path,
    inicio_corte: float,
    fim_corte: float,
    pasta_fontes: str | Path = DEFAULT_FONT_DIR,
    style: CaptionStyle | None = None,
) -> tuple[Path, Path]:
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
        # A long word or an all-caps phrase must not escape the safe area.
        # Keep one font size for the entire group, including every highlight.
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
    filtro = f"ass='{filter_path(ass_path)}':fontsdir='{filter_path(pasta_fontes)}'"

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(arquivo_video),
            "-vf", filtro,
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-c:a", "copy",
            "-movflags", "+faststart",
            str(video_legenda),
        ],
        check=True,
    )

    ass_path.unlink(missing_ok=True)
    return srt_path, video_legenda


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

    if hashtags.strip():
        texto += "\n\n" + hashtags.strip()

    destino.write_text(texto.strip() + "\n", encoding="utf-8")
    return destino
