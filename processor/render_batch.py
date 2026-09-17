from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from .captions import CaptionStyle, carregar_palavras, criar_legendas_corte, escrever_post
from .drive import uploader_por_env
from .progress import completed, emit, failed
from .tracking import render_tracking_9x16
from .utils import nome_seguro, tempo_para_segundos


def ajustar_inicio_sem_silencio(palavras: list[dict], inicio_corte: float, fim_corte: float) -> float:
    """Elimina silêncio ou respiração inicial para que a primeira fala coincida rigorosamente com os primeiros 100ms."""
    for p in palavras:
        if p["fim"] <= inicio_corte:
            continue
        if p["inicio"] >= fim_corte:
            break
        p_inicio = float(p.get("inicio", inicio_corte))
        gap = p_inicio - inicio_corte
        if 0.12 < gap <= 2.0:
            # Puxa o início para 80ms antes da primeira sílaba audível
            return max(inicio_corte, p_inicio - 0.08)
        break
    return inicio_corte


def normalizar_cortes(raw: str) -> list[dict]:
    data = json.loads(raw)
    cortes = data if isinstance(data, list) else data.get("cortes", [])
    if not isinstance(cortes, list) or not cortes:
        raise ValueError("Nenhum corte encontrado no pacote.")
    if len(cortes) > 30:
        raise ValueError("Máximo de 30 cortes por processamento.")

    saida: list[dict] = []
    for idx, corte in enumerate(cortes, start=1):
        if not isinstance(corte, dict):
            raise ValueError(f"Corte {idx} inválido.")

        titulo = str(corte.get("titulo") or f"Corte {idx}").strip()
        inicio = tempo_para_segundos(corte.get("inicio", 0))
        fim = tempo_para_segundos(corte.get("fim", 0))
        if fim <= inicio:
            raise ValueError(f"Corte {idx}: fim precisa ser maior que início.")

        hashtags = corte.get("hashtags", "")
        if isinstance(hashtags, list):
            hashtags = " ".join(str(x).strip() for x in hashtags if str(x).strip())
        else:
            hashtags = str(hashtags or "").strip()

        saida.append(
            {
                "titulo": titulo,
                "inicio": inicio,
                "fim": fim,
                "legenda_post": str(corte.get("legenda_post") or "").strip(),
                "hashtags": hashtags,
            }
        )
    return saida


def main() -> int:
    parser = argparse.ArgumentParser(description="Gera todos os cortes de uma sessão já transcrita.")
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--folder-id", required=True)
    parser.add_argument("--video-file-id", required=True)
    parser.add_argument("--transcript-json-file-id", required=True)
    parser.add_argument("--cuts-json", required=True)
    parser.add_argument("--workdir", default=".work")
    parser.add_argument("--output", default="output")
    args = parser.parse_args()

    work = Path(args.workdir).resolve()
    out = Path(args.output).resolve()
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)

    try:
        cortes = normalizar_cortes(args.cuts_json)
        total = len(cortes)
        uploader = uploader_por_env()
        if uploader is None:
            raise RuntimeError("Google Drive não está configurado no GitHub Actions.")

        emit("preparando_cortes", 2.0, f"Preparando {total} cortes", total_cuts=total)

        video = work / "video_base.mp4"
        transcricao_json = work / "transcricao.json"

        def progresso_download(fracao: float) -> None:
            emit(
                "baixando_base",
                3.0 + fracao * 5.0,
                "Baixando vídeo-base do Google Drive",
                stage_percent=fracao * 100.0,
                total_cuts=total,
            )

        uploader.download(args.video_file_id, video, progress_cb=progresso_download)
        emit("baixando_base", 8.0, "Vídeo-base pronto", stage_percent=100, total_cuts=total)
        uploader.download(args.transcript_json_file_id, transcricao_json)
        emit("baixando_base", 10.0, "Transcrição carregada", total_cuts=total)

        palavras_globais = carregar_palavras(transcricao_json)
        resultados: list[dict] = []
        faixa = 85.0 / total

        for i, corte in enumerate(cortes, start=1):
            base_inicio = 10.0 + (i - 1) * faixa
            titulo_arquivo = nome_seguro(corte["titulo"])
            prefixo = f"corte_{i:02d}_{titulo_arquivo}"
            video_corte = out / f"{prefixo}.mp4"

            # Ajuste dinâmico para o som coincidir rigorosamente com os primeiros ~100ms do corte
            inicio_efetivo = ajustar_inicio_sem_silencio(
                palavras_globais, corte["inicio"], corte["fim"]
            )

            emit(
                "tracking",
                base_inicio,
                f"Gerando corte {i}/{total}: {corte['titulo']}",
                cut=i,
                total_cuts=total,
            )
            render_tracking_9x16(
                video,
                inicio_efetivo,
                corte["fim"],
                video_corte,
                work_dir=work,
            )

            emit(
                "legendas",
                base_inicio + faixa * 0.48,
                f"Aplicando legendas no corte {i}/{total}",
                cut=i,
                total_cuts=total,
            )
            srt_path, video_legenda, capa_path = criar_legendas_corte(
                transcricao_json,
                video_corte,
                inicio_efetivo,
                corte["fim"],
                titulo=corte["titulo"],
                style=CaptionStyle(),
            )
            post_path = escrever_post(
                out / f"{prefixo}_post.txt",
                corte["titulo"],
                corte["legenda_post"],
                corte["hashtags"],
            )

            emit(
                "drive",
                base_inicio + faixa * 0.68,
                f"Salvando corte {i}/{total} no Google Drive",
                cut=i,
                total_cuts=total,
            )

            arquivos = [
                ("video", video_corte),
                ("videoLegenda", video_legenda),
                ("srt", srt_path),
                ("post", post_path),
            ]
            if capa_path and capa_path.exists():
                arquivos.append(("capa", capa_path))

            ids: dict[str, str] = {}

            for pos, (chave, arquivo) in enumerate(arquivos, start=1):
                file_id = uploader.upload(arquivo, folder_id=args.folder_id)
                ids[chave] = file_id
                emit(
                    "drive",
                    base_inicio + faixa * (0.68 + 0.30 * (pos / len(arquivos))),
                    f"Corte {i}/{total}: arquivo {pos}/{len(arquivos)} salvo",
                    cut=i,
                    total_cuts=total,
                )

            files_dict = {
                "video": {
                    "id": ids["video"],
                    "url": f"https://drive.google.com/file/d/{ids['video']}/view",
                },
                "videoLegenda": {
                    "id": ids["videoLegenda"],
                    "url": f"https://drive.google.com/file/d/{ids['videoLegenda']}/view",
                },
                "srt": {
                    "id": ids["srt"],
                    "url": f"https://drive.google.com/file/d/{ids['srt']}/view",
                },
                "post": {
                    "id": ids["post"],
                    "url": f"https://drive.google.com/file/d/{ids['post']}/view",
                },
            }
            if "capa" in ids:
                files_dict["capa"] = {
                    "id": ids["capa"],
                    "url": f"https://drive.google.com/file/d/{ids['capa']}/view",
                }

            resultados.append(
                {
                    "index": i,
                    "titulo": corte["titulo"],
                    "inicio": corte["inicio"],
                    "fim": corte["fim"],
                    "files": files_dict,
                }
            )

            for arquivo in (video_corte, video_legenda, srt_path, post_path):
                try:
                    arquivo.unlink(missing_ok=True)
                except Exception:
                    pass

            emit(
                "cortes",
                base_inicio + faixa,
                f"Corte {i}/{total} concluído",
                cut=i,
                total_cuts=total,
            )

        result = {
            "requestId": args.request_id,
            "folderId": args.folder_id,
            "driveFolderUrl": f"https://drive.google.com/drive/folders/{args.folder_id}",
            "cuts": resultados,
        }
        completed(f"{total} cortes concluídos e salvos no Drive", result)
        return 0
    except Exception as exc:
        failed("Falha ao gerar os cortes", str(exc))
        raise
    finally:
        try:
            shutil.rmtree(work, ignore_errors=True)
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
