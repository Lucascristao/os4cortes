from __future__ import annotations

import json
import re
import subprocess
import urllib.request
from dataclasses import dataclass
from pathlib import Path


ARCHIVO_BLACK_URL = (
    "https://raw.githubusercontent.com/google/fonts/"
    "main/ofl/archivoblack/ArchivoBlack-Regular.ttf"
)


@dataclass
class CaptionStyle:
    font_name: str = "Archivo Black"
    font_size: int = 68
    margin_v: int = 330
    outline: int = 4
    shadow: int = 0
    max_words: int = 9
    max_chars: int = 54
    pause_cut: float = 0.55


def garantir_archivo_black(
    pasta_fontes: str | Path = "/usr/local/share/fonts/truetype/cortai",
) -> Path:
    pasta_fontes = Path(pasta_fontes)
    pasta_fontes.mkdir(parents=True, exist_ok=True)
    font_path = pasta_fontes / "ArchivoBlack-Regular.ttf"

    if not font_path.exists() or font_path.stat().st_size < 50_000:
        urllib.request.urlretrieve(ARCHIVO_BLACK_URL, font_path)

    scan = subprocess.run(
        ["fc-scan", "--format", "%{family}\n", str(font_path)],
        capture_output=True,
        text=True,
        check=True,
    )

    if "Archivo Black" not in scan.stdout:
        raise RuntimeError("O TTF baixado não foi reconhecido como Archivo Black.")

    subprocess.run(
        ["fc-cache", "-f"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    return font_path


def srt_tempo(segundos: float) -> str:
    segundos = max(0.0, float(segundos))
    horas = int(segundos // 3600)
    minutos = int((segundos % 3600) // 60)
    resto = segundos % 60
    segundos_int = int(resto)
    ms = int(round((resto - segundos_int) * 1000))

    if ms >= 1000:
        segundos_int += 1
        ms = 0

    return f"{horas:02d}:{minutos:02d}:{segundos_int:02d},{ms:03d}"


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


def agrupar_palavras(palavras: list[dict], style: CaptionStyle) -> list[list[dict]]:
    grupos: list[list[dict]] = []
    atual: list[dict] = []

    for palavra in palavras:
        pausa = palavra["inicio"] - atual[-1]["fim"] if atual else 0.0
        texto_teste = juntar_palavras(atual + [palavra])

        precisa_quebrar = bool(atual) and (
            len(atual) >= style.max_words
            or len(texto_teste) > style.max_chars
            or pausa >= style.pause_cut
        )

        if precisa_quebrar:
            grupos.append(atual)
            atual = []

        atual.append(palavra)

        if re.search(r"[.!?]$", palavra["texto"]) and len(atual) >= 4:
            grupos.append(atual)
            atual = []

    if atual:
        grupos.append(atual)

    return grupos


def melhor_quebra(palavras: list[dict]) -> int:
    if len(palavras) <= 3:
        return len(palavras)

    melhor_score = None
    melhor_idx = len(palavras)

    for corte in range(1, len(palavras)):
        linha1 = " ".join(p["texto"] for p in palavras[:corte])
        linha2 = " ".join(p["texto"] for p in palavras[corte:])
        maior = max(len(linha1), len(linha2))
        diferenca = abs(len(linha1) - len(linha2))
        score = maior * 2 + diferenca

        if melhor_score is None or score < melhor_score:
            melhor_score = score
            melhor_idx = corte

    return melhor_idx


def texto_ass_grupo(palavras: list[dict], indice_ativo: int) -> str:
    tokens: list[str] = []

    for i, p in enumerate(palavras):
        texto = escapar_ass(p["texto"])
        if i == indice_ativo:
            texto = r"{\c&H0000FFFF&}" + texto + r"{\c&H00FFFFFF&}"
        tokens.append(texto)

    corte = melhor_quebra(palavras)

    if corte >= len(tokens):
        return " ".join(tokens)

    return " ".join(tokens[:corte]) + r"\N" + " ".join(tokens[corte:])


def texto_srt_grupo(grupo: list[dict]) -> str:
    texto = juntar_palavras(grupo)
    tokens = texto.split()

    if len(tokens) < 5:
        return texto

    pseudo = [{"texto": t} for t in tokens]
    corte = melhor_quebra(pseudo)

    if corte >= len(tokens):
        return texto

    return " ".join(tokens[:corte]) + "\n" + " ".join(tokens[corte:])


def criar_legendas_corte(
    transcricao_path: str | Path,
    arquivo_video: str | Path,
    inicio_corte: float,
    fim_corte: float,
    pasta_fontes: str | Path = "/usr/local/share/fonts/truetype/cortai",
    style: CaptionStyle | None = None,
) -> tuple[Path, Path]:
    style = style or CaptionStyle()
    pasta_fontes = Path(pasta_fontes)
    garantir_archivo_black(pasta_fontes)

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
                texto_srt_grupo(grupo),
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
        for wi, palavra in enumerate(grupo):
            inicio = palavra["inicio"]
            if wi + 1 < len(grupo):
                fim = grupo[wi + 1]["inicio"]
            else:
                fim = palavra["fim"]

            fim = max(fim, inicio + 0.06)
            texto_evento = texto_ass_grupo(grupo, wi)

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

    filtro = f"ass={ass_path}:fontsdir={pasta_fontes}"

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
