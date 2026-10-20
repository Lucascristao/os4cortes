from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

from .branding import normalize_branding
from .captions import (
    CaptionStyle,
    carregar_palavras,
    criar_legendas_corte,
    criar_srt_limpo,
    escrever_post,
    escrever_post_youtube,
    garantir_archivo_black,
)
from .covers import CoverError, normalize_cover, render_cover
from .drive import uploader_por_env
from .cut_transport import decode_cuts_json
from .editorial_plan import editorial_fingerprint, normalize_editorial_plan
from .progress import completed, emit, failed, start_heartbeat
from .publisher import save_publisher_manifest
from .lower_third import LowerThird
try:
    from .tracking import render_cinematic_16x9, render_tracking_9x16
except ImportError:
    render_cinematic_16x9 = None
    render_tracking_9x16 = None
from .utils import nome_seguro, tempo_para_segundos

SIMPLE_VIDEO_CACHE_VERSION = "os4-simple-video-v1"


def _file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _render_simple_video(video, start, end, output, *, aspect, work_dir, cache_dir,
                         lower_third, fade_out_visual, source_sha256=None):
    """Reuse source-only video; cover and publication edits do not change this key."""
    config = {
        "version": SIMPLE_VIDEO_CACHE_VERSION,
        "source_sha256": source_sha256 or _file_sha256(video),
        "span": [start, end], "aspect": aspect,
        "lower_third": {"mode": lower_third.mode, "height_fraction": lower_third.height_fraction},
        "fade_out_visual": fade_out_visual,
    }
    key = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    cache_dir, output = Path(cache_dir), Path(output)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached_video, sidecar = cache_dir / f"{key}.mp4", cache_dir / f"{key}.json"
    record = {}
    try:
        record = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    valid = (isinstance(record, dict) and record.get("key") == key and cached_video.is_file()
             and record.get("sha256") == _file_sha256(cached_video))
    if not valid:
        renderer = render_cinematic_16x9 if aspect == "16:9" else render_tracking_9x16
        renderer(video, start, end, cached_video, work_dir=work_dir,
                 fade_out_visual=fade_out_visual, lower_third=lower_third)
        record = {"key": key, "sha256": _file_sha256(cached_video), "config": config}
        sidecar.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.resolve() != cached_video.resolve():
        shutil.copyfile(cached_video, output)
    return {"key": key, "cache_hit": bool(valid), "sha256": record["sha256"]}


def render_editorial_cut(*args, **kwargs):
    # The legacy path never imports the voice/compositor runtime.
    from .editorial_renderer import render_editorial_cut as renderer
    return renderer(*args, **kwargs)


def _editorial_assets(video, transcript, corte, index, out, work, cache, lower_third):
    aspect = corte["formato"]
    prefix = f"corte_{index:02d}_{nome_seguro(corte['titulo'])}"
    if aspect == "16:9":
        prefix += "_16x9"
    # The local publisher recognizes the captioned vertical by this suffix.
    output = out / (f"{prefix}.mp4" if aspect == "16:9" else f"{prefix}_legenda.mp4")
    voice_dir = cache / editorial_fingerprint(corte["editorial"]) / "voice"
    voice_dir.mkdir(parents=True, exist_ok=True)
    font = garantir_archivo_black()
    rendered = render_editorial_cut(
        video, transcript, corte["editorial"], output,
        work_dir=work / f"editorial-{index:02d}", aspect=aspect,
        lower_third=lower_third, voice_dir=voice_dir, font_dir=Path(font).parent,
        cover=corte["cover"], title=corte["titulo"],
    )
    video_path, srt_path = Path(rendered["video"]), Path(rendered["srt"])
    cover = Path(rendered["capa"]) if rendered.get("capa") else None
    report = Path(rendered["report"]) if rendered.get("report") else None
    if aspect == "16:9":
        post = escrever_post_youtube(out / f"{prefix}_post.txt", corte["titulo"], corte["descricao"], corte["tags"])
    else:
        post = escrever_post(out / f"{prefix}_post.txt", corte["titulo"], corte["legenda_post"], corte["hashtags"])
    assets = [("video", video_path), ("srt", srt_path), ("post", post)]
    if not cover or not cover.is_file():
        raise CoverError("A capa obrigatória do corte autoral não foi gerada.")
    assets.append(("capa", cover))
    metadata = json.loads(report.read_text(encoding="utf-8")) if report and report.exists() else {}
    # Reports and synthesis caches stay local; they are not publisher uploads.
    cleanup = [video_path, srt_path, post, cover, report, output.with_suffix(".render-cache.json")]
    return assets, cleanup, metadata


def _cut_error(errors, corte, index, total, progress, exc):
    error = {"index": index, "titulo": corte["titulo"], "error": str(exc)}
    errors.append(error)
    emit("cortes", progress, f"Corte {index}/{total} falhou: {exc}", cut=index, total_cuts=total)


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


def normalizar_cortes(raw: str, *, cut_mode: str | None = None) -> list[dict]:
    data = json.loads(decode_cuts_json(raw))
    cortes = data if isinstance(data, list) else data.get("cortes", [])
    if not isinstance(cortes, list) or not cortes:
        raise ValueError("Nenhum corte encontrado no pacote.")

    saida: list[dict] = []
    for idx, corte in enumerate(cortes, start=1):
        if not isinstance(corte, dict):
            raise ValueError(f"Corte {idx} inválido.")

        titulo = normalize_branding(str(corte.get("titulo") or f"Corte {idx}")).strip()
        inicio = tempo_para_segundos(corte.get("inicio", 0))
        fim = tempo_para_segundos(corte.get("fim", 0))
        if fim <= inicio:
            raise ValueError(f"Corte {idx}: fim precisa ser maior que início.")

        if "editorial" in corte:
            try:
                editorial = normalize_editorial_plan(corte["editorial"], clip_start=inicio, clip_end=fim)
            except ValueError as exc:
                raise ValueError(f"Corte {idx}: {exc}") from exc
        if "editorial" in corte and cut_mode != "simple":
            # Only source excerpts count toward the OS4 vertical limit, not voice,
            # backgrounds, evidence, or the source envelope. Replays count again.
            duracao = round(sum(scene["end"] - scene["start"] for scene in editorial["scenes"]
                                if scene["kind"] == "clip"), 6)
        else:
            duracao = round(fim - inicio, 6)
        formato = str(corte.get("formato") or "").strip().lower()
        destino = str(corte.get("destino") or corte.get("plataforma") or "").strip().lower()

        # Roteamento automático de formato
        if destino == "youtube" or formato == "16:9" or duracao > 180:
            formato = "16:9"
            destino = "youtube"
        else:
            formato = "9:16"
            destino = "reels_tiktok"
        try:
            if "cover" in corte and corte["cover"] is None:
                raise CoverError("cover deve ser um objeto version: 1.")
            cover = normalize_cover(corte.get("cover"), titulo, formato)
        except ValueError as exc:
            raise ValueError(f"Corte {idx}: {exc}") from exc

        descricao = normalize_branding(str(corte.get("descricao") or corte.get("descricao_completa") or corte.get("legenda_post") or "")).strip()
        tags = corte.get("tags") or corte.get("hashtags") or ""
        if isinstance(tags, list):
            tags = [normalize_branding(str(x)) for x in tags]
            tags_formatadas = " ".join(str(x).strip() for x in tags if str(x).strip())
        else:
            tags = normalize_branding(str(tags or "")).strip()
            tags_formatadas = tags

        saida.append(
            {
                "titulo": titulo,
                "inicio": inicio,
                "fim": fim,
                "formato": formato,
                "destino": destino,
                "descricao": descricao,
                "legenda_post": normalize_branding(str(corte.get("legenda_post") or descricao)).strip(),
                "hashtags": tags_formatadas,
                "tags": tags,
                "saida_suave": bool(corte.get("saida_suave", True)),
                "cover": cover,
                **({"editorial": editorial} if "editorial" in corte else {}),
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
    parser.add_argument("--cut-mode", choices=("simple", "editorial"), default="simple")
    parser.add_argument("--editorial-cache-root", default=".editorial-cache")
    parser.add_argument("--lower-third-mode", choices=("off", "cover", "crop"), default="off")
    parser.add_argument("--lower-third-height", type=float, default=0.0)
    args = parser.parse_args()
    lower_third = LowerThird(args.lower_third_mode, args.lower_third_height)

    work = Path(args.workdir).resolve()
    out = Path(args.output).resolve()
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)

    cleanup_work = True
    heartbeat = start_heartbeat()
    try:
        cortes = normalizar_cortes(args.cuts_json, cut_mode=args.cut_mode)
        total = len(cortes)
        cache = Path(args.editorial_cache_root).resolve()
        if args.cut_mode == "editorial":
            # Validate the entire package before looking for a key or touching Drive.
            for index, corte in enumerate(cortes, 1):
                if "editorial" not in corte:
                    raise ValueError(f"Corte {index}: o modo editorial exige um plano editorial version: 1 em todos os cortes.")
            if cache == work or work in cache.parents:
                # A rejected path must not delete already accepted voice files.
                cleanup_work = False
                raise ValueError("O cache editorial deve ficar fora do diretório temporário de trabalho.")
            if not os.environ.get("GEMINI_API_KEY", "").strip():
                raise RuntimeError("GEMINI_API_KEY precisa estar configurada para gerar cortes autorais.")
        uploader = uploader_por_env()
        if uploader is None:
            raise RuntimeError("Google Drive não está configurado no GitHub Actions.")

        emit("preparando_cortes", 2.0, f"Preparando {total} cortes", total_cuts=total)
        save_publisher_manifest(uploader, args.folder_id, work)

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
        source_sha256 = _file_sha256(video) if args.cut_mode == "simple" else None

        palavras_globais = carregar_palavras(transcricao_json)
        resultados: list[dict] = []
        errors: list[dict] = []
        faixa = 85.0 / total

        for i, corte in enumerate(cortes, start=1):
            base_inicio = 10.0 + (i - 1) * faixa
            titulo_arquivo = nome_seguro(corte["titulo"])
            formato = corte.get("formato", "9:16")
            destino = corte.get("destino", "reels_tiktok")

            # Ajuste dinâmico para o som coincidir rigorosamente com os primeiros ~100ms do corte
            inicio_efetivo = corte["inicio"] if args.cut_mode == "editorial" else ajustar_inicio_sem_silencio(
                palavras_globais, corte["inicio"], corte["fim"]
            )
            usar_fade_visual = not corte.get("saida_suave", True)

            limpar_arquivos = []
            metadata = {}
            prefixo = f"corte_{i:02d}_{titulo_arquivo}" + ("_16x9" if formato == "16:9" else "")
            if args.cut_mode == "simple":
                capa_path = out / f"{prefixo}_capa.jpg"
                try:
                    cover_report = render_cover(
                        video, [(inicio_efetivo, corte["fim"])], capa_path,
                        cover=corte.get("cover"), title=corte["titulo"], aspect=formato,
                        lower_third=lower_third, work_dir=cache / "covers",
                    )
                    metadata = {"cover": cover_report, "first_original_clip_seconds": 0.0,
                                "duration_seconds": corte["fim"] - inicio_efetivo,
                                "source_clip_seconds": corte["fim"] - inicio_efetivo}
                except CoverError as exc:
                    _cut_error(errors, corte, i, total, base_inicio + faixa, exc)
                    continue

            if args.cut_mode == "editorial":
                emit("tracking", base_inicio, f"Montando vídeo autoral {i}/{total}: {corte['titulo']}", cut=i, total_cuts=total)
                try:
                    arquivos, limpar_arquivos, metadata = _editorial_assets(
                        video, transcricao_json, corte, i, out, work, cache, lower_third,
                    )
                except Exception as exc:
                    _cut_error(errors, corte, i, total, base_inicio + faixa, exc)
                    continue
            elif formato == "16:9":
                prefixo = f"corte_{i:02d}_{titulo_arquivo}_16x9"
                video_16x9 = out / f"{prefixo}.mp4"

                emit(
                    "tracking",
                    base_inicio,
                    f"Gerando corte YouTube 16:9 {i}/{total}: {corte['titulo']}",
                    cut=i,
                    total_cuts=total,
                )
                _render_simple_video(
                    video,
                    inicio_efetivo,
                    corte["fim"],
                    video_16x9,
                    aspect=formato,
                    work_dir=work,
                    cache_dir=cache / "simple-video",
                    source_sha256=source_sha256,
                    fade_out_visual=usar_fade_visual,
                    lower_third=lower_third,
                )

                emit(
                    "legendas",
                    base_inicio + faixa * 0.48,
                    f"Preparando metadados YouTube do corte {i}/{total}",
                    cut=i,
                    total_cuts=total,
                )
                srt_path = criar_srt_limpo(
                    transcricao_json,
                    out / f"{prefixo}.srt",
                    inicio_efetivo,
                    corte["fim"],
                )
                post_path = escrever_post_youtube(
                    out / f"{prefixo}_post.txt",
                    corte["titulo"],
                    corte["descricao"],
                    corte["tags"],
                )

                arquivos = [
                    ("video", video_16x9),
                    ("srt", srt_path),
                    ("post", post_path),
                ]
                if capa_path and capa_path.exists():
                    arquivos.append(("capa", capa_path))

                limpar_arquivos = [video_16x9, srt_path, post_path, capa_path]
            else:
                prefixo = f"corte_{i:02d}_{titulo_arquivo}"
                video_corte = out / f"{prefixo}.mp4"

                emit(
                    "tracking",
                    base_inicio,
                    f"Gerando corte vertical {i}/{total}: {corte['titulo']}",
                    cut=i,
                    total_cuts=total,
                )
                _render_simple_video(
                    video,
                    inicio_efetivo,
                    corte["fim"],
                    video_corte,
                    aspect=formato,
                    work_dir=work,
                    cache_dir=cache / "simple-video",
                    source_sha256=source_sha256,
                    fade_out_visual=usar_fade_visual,
                    lower_third=lower_third,
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
                    saida_suave=corte.get("saida_suave", True),
                    capa_pronta=capa_path,
                    gerar_capa=False,
                )
                post_path = escrever_post(
                    out / f"{prefixo}_post.txt",
                    corte["titulo"],
                    corte["legenda_post"],
                    corte["hashtags"],
                )

                arquivos = [
                    ("video", video_corte),
                    ("videoLegenda", video_legenda),
                    ("srt", srt_path),
                    ("post", post_path),
                ]
                if capa_path and capa_path.exists():
                    arquivos.append(("capa", capa_path))

                limpar_arquivos = [video_corte, video_legenda, srt_path, post_path, capa_path]

            emit(
                "drive",
                base_inicio + faixa * 0.68,
                f"Salvando corte {i}/{total} no Google Drive",
                cut=i,
                total_cuts=total,
            )

            ids: dict[str, str] = {}

            try:
                if not any(key == "capa" and Path(path).is_file() for key, path in arquivos):
                    raise CoverError("Capa obrigatória ausente; o corte não pode ser marcado como pronto.")
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
            except Exception as exc:
                if args.cut_mode == "simple" and not isinstance(exc, CoverError):
                    raise
                _cut_error(errors, corte, i, total, base_inicio + faixa, exc)
                continue

            files_dict = {
                "video": {
                    "id": ids["video"],
                    "url": f"https://drive.google.com/file/d/{ids['video']}/view",
                },
                "videoLegenda": {
                    "id": ids.get("videoLegenda", ids["video"]),
                    "url": f"https://drive.google.com/file/d/{ids.get('videoLegenda', ids['video'])}/view",
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
                    "formato": formato,
                    "destino": destino,
                    "cover": corte["cover"],
                    "render": {key: metadata[key] for key in (
                        "cover", "first_original_clip_seconds", "duration_seconds", "source_clip_seconds", "editorial_warnings"
                    ) if key in metadata},
                    "files": files_dict,
                }
            )

            for arquivo in limpar_arquivos:
                if arquivo:
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
                ready_cut=resultados[-1],
            )

        result = {
            "requestId": args.request_id,
            "folderId": args.folder_id,
            "driveFolderUrl": f"https://drive.google.com/drive/folders/{args.folder_id}",
            "cuts": resultados,
        }
        if args.cut_mode == "editorial" or errors:
            result.update(errors=errors, requestedCount=total, completedCount=len(resultados))
            (out / "render-batch-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            detail = f"{len(resultados)}/{total} cortes {'autorais ' if args.cut_mode == 'editorial' else ''}salvos no Drive"
            if errors:
                detail += f"; {len(errors)} falhou/falharam"
            if not resultados:
                emit("erro", 100.0, detail, status="error", result=result, error=detail)
                return 1
            completed(detail, result)
        else:
            completed(f"{total} cortes concluídos e salvos no Drive", result)
        return 0
    except Exception as exc:
        failed("Falha ao gerar os cortes", str(exc))
        raise
    finally:
        heartbeat.set()
        try:
            if cleanup_work:
                shutil.rmtree(work, ignore_errors=True)
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
