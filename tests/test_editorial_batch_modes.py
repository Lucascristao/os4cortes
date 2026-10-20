"""Offline batch routing, preflight, publisher compatibility and recovery tests."""
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from processor import render_batch as batch
from processor.editorial_plan import editorial_fingerprint
from processor.lower_third import LowerThird


def plan(label="Fonte"):
    return {
        "version": 1, "source": {"label": label, "date": ""},
        "scenes": [
            {"id": "abertura", "kind": "narration", "text": "O que esta fala esclarece?",
             "background": {"start": 10, "end": 13},
             "visual": {"title": "O que foi dito?", "kicker": "SEGUNDO A FONTE", "lines": []},
             "tts": {"delivery": "explain", "cues": []},
             "evidence": [{"start": 10, "end": 14}]},
            {"id": "fala", "kind": "clip", "start": 10.05, "end": 19.95},
        ],
    }


def cut(*, aspect="9:16", editorial=True, label="Fonte"):
    value = {"titulo": "Uma resposta", "inicio": 10, "fim": 20, "formato": aspect,
             "legenda_post": "Comentário próprio e crédito.", "descricao": "Descrição e crédito.",
             "hashtags": ["#assunto"], "tags": ["assunto do vídeo"], "saida_suave": False}
    if editorial:
        value["editorial"] = plan(label)
    return value


class FakeUploader:
    def __init__(self):
        self.downloads = []
        self.uploads = []

    def download(self, file_id, path, progress_cb=None):
        self.downloads.append(file_id)
        Path(path).write_text("{}", encoding="utf-8")

    def upload(self, path, *, folder_id):
        path = Path(path)
        self.uploads.append({"name": path.name, "data": path.read_bytes(), "folder": folder_id})
        return f"file-{len(self.uploads)}"


class Harness:
    def __init__(self, cuts, *, mode=None, key="unit-test-key", extra=()):
        # Keep test-owned data in the checkout; Windows app-container TEMP ACLs
        # can otherwise deny child-directory creation even for offline tests.
        self.temp = tempfile.TemporaryDirectory(prefix=".test-editorial-batch-", dir=Path(__file__).resolve().parents[1])
        self.root = Path(self.temp.name)
        self.work, self.out, self.cache = (self.root/name for name in ("work", "out", ".editorial-cache"))
        self.uploader = FakeUploader()
        self.factory = Mock(return_value=self.uploader)
        self.renderer = Mock(side_effect=self.render)
        self.tracking = Mock(side_effect=self.track)
        self.cinematic = Mock(side_effect=self.track)
        self.completed, self.failed, self.emit = Mock(), Mock(), Mock()
        self.heartbeat = Mock()
        self.argv = ["render_batch", "--request-id", "request", "--folder-id", "folder",
                     "--video-file-id", "video", "--transcript-json-file-id", "transcript",
                     "--cuts-json", json.dumps(cuts), "--workdir", str(self.work),
                     "--output", str(self.out), "--editorial-cache-root", str(self.cache)]
        if mode is not None:
            self.argv += ["--cut-mode", mode]
        self.argv += list(extra)
        self.key = key

    @staticmethod
    def touch(path, data=b"media"):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def render(self, video, transcript, editorial, output, **kwargs):
        voice = Path(kwargs["voice_dir"])
        self.touch(voice/"accepted.wav", b"accepted voice")
        if editorial["source"]["label"] == "Falha":
            raise RuntimeError("Síntese de uma cena rejeitada")
        output = Path(output)
        return {
            "video": self.touch(output), "srt": self.touch(output.with_suffix(".srt"), b"timed captions"),
            "capa": self.touch(output.with_name(output.stem+"_capa.jpg")),
            "report": self.touch(output.with_suffix(".render-report.json"), b"{}"),
        }

    def track(self, video, start, end, output, **kwargs):
        return self.touch(output)

    def captions(self, transcript, video, start, end, **kwargs):
        video = Path(video)
        return (self.touch(video.with_suffix(".srt")),
                self.touch(video.with_name(video.stem+"_legenda.mp4")),
                self.touch(video.with_name(video.stem+"_capa.jpg")))

    def __enter__(self):
        self.stack = ExitStack()
        self.stack.enter_context(patch("sys.argv", self.argv))
        self.stack.enter_context(patch.dict(batch.os.environ, {"GEMINI_API_KEY": self.key}))
        substitutions = {
            "uploader_por_env": self.factory, "save_publisher_manifest": Mock(),
            "start_heartbeat": Mock(return_value=self.heartbeat),
            "completed": self.completed, "failed": self.failed, "emit": self.emit,
            "render_editorial_cut": self.renderer,
            "render_tracking_9x16": self.tracking, "render_cinematic_16x9": self.cinematic,
            "carregar_palavras": Mock(return_value=[{"texto": "fala", "inicio": 10.8, "fim": 19.9}]),
            "criar_legendas_corte": Mock(side_effect=self.captions),
            "criar_srt_limpo": Mock(side_effect=lambda transcript, path, *args: self.touch(path)),
            "render_cover": Mock(side_effect=lambda video, ranges, path, **kwargs: {
                "path": str(self.touch(path)), "requested_template_id": kwargs["cover"]["template_id"],
                "applied_template_id": kwargs["cover"]["template_id"], "sha256": "cover-hash",
            }),
            "garantir_archivo_black": Mock(return_value=self.root/"fonts"/"ArchivoBlack-Regular.ttf"),
        }
        for name, value in substitutions.items():
            self.stack.enter_context(patch.object(batch, name, value))
        return self

    def __exit__(self, *args):
        self.stack.__exit__(*args)
        self.temp.cleanup()


class EditorialBatchModesTests(unittest.TestCase):
    def test_editorial_requires_every_plan_before_key_or_drive(self):
        with Harness([cut(), cut(editorial=False)], mode="editorial", key="") as h:
            with self.assertRaisesRegex(ValueError, "Corte 2:.*todos os cortes"):
                batch.main()
            h.factory.assert_not_called()
            h.renderer.assert_not_called()

    def test_editorial_requires_key_before_uploader_or_download(self):
        with Harness([cut()], mode="editorial", key="") as h:
            with self.assertRaisesRegex(RuntimeError, "GEMINI_API_KEY"):
                batch.main()
            h.factory.assert_not_called()
            self.assertFalse(h.uploader.downloads)
            h.renderer.assert_not_called()

    def test_voice_cache_must_stay_outside_temporary_work(self):
        with Harness([cut()], mode="editorial") as h:
            h.argv += ["--editorial-cache-root", str(h.work/"cache")]
            accepted = h.touch(h.work/"cache"/"accepted.wav", b"existing accepted voice")
            with self.assertRaisesRegex(ValueError, "fora do diretório temporário"):
                batch.main()
            h.factory.assert_not_called()
            self.assertTrue(accepted.exists())

    def test_default_simple_routes_both_legacy_formats_without_key_or_compositor(self):
        # Even an incidental plan in a package does not opt the simple mode into TTS.
        with Harness([cut(editorial=False), cut(aspect="16:9")], key="") as h:
            self.assertEqual(batch.main(), 0)
            h.renderer.assert_not_called()
            h.tracking.assert_called_once()
            h.cinematic.assert_called_once()
            batch.garantir_archivo_black.assert_not_called()
            self.assertAlmostEqual(h.tracking.call_args.args[1], 10.72)
            self.assertEqual(h.cinematic.call_args.kwargs["fade_out_visual"], True)
            self.assertNotIn("errors", h.completed.call_args.args[1])
            self.assertIn("2 cortes concluídos", h.completed.call_args.args[0])

    def test_selected_mode_controls_routing_when_a_simple_package_contains_an_incidental_plan(self):
        value = cut()
        value.update(inicio=0, fim=600)
        for mode in (None, "simple", "editorial"):
            is_editorial = mode == "editorial"
            with self.subTest(mode=mode), Harness([value], mode=mode, key="unit-test-key" if is_editorial else "") as h:
                self.assertEqual(batch.main(), 0)
                result = h.completed.call_args.args[1]["cuts"][0]
                if is_editorial:
                    h.renderer.assert_called_once()
                    h.cinematic.assert_not_called()
                    self.assertEqual(h.renderer.call_args.kwargs["aspect"], "9:16")
                    self.assertEqual((result["formato"], result["destino"]), ("9:16", "reels_tiktok"))
                else:
                    h.renderer.assert_not_called()
                    h.cinematic.assert_called_once()
                    self.assertEqual(h.cinematic.call_args.args[1:3], (0.0, 600.0))
                    batch.garantir_archivo_black.assert_not_called()
                    self.assertFalse(list(h.cache.rglob("accepted.wav")))
                    self.assertEqual((result["formato"], result["destino"]), ("16:9", "youtube"))
                h.tracking.assert_not_called()

    def test_explicit_simple_keeps_legacy_fail_fast(self):
        with Harness([cut(editorial=False), cut(editorial=False)], mode="simple", key="") as h:
            h.tracking.side_effect = RuntimeError("legacy render failed")
            with self.assertRaisesRegex(RuntimeError, "legacy render failed"):
                batch.main()
            self.assertEqual(h.tracking.call_count, 1)
            h.renderer.assert_not_called()
            h.failed.assert_called_once()

    def test_simple_cover_changes_reuse_source_video_for_both_formats(self):
        for aspect in ("9:16", "16:9"):
            cuts = [cut(aspect=aspect, editorial=False), cut(aspect=aspect, editorial=False)]
            for value, template, title in zip(cuts, ("01_central", "03_close"), ("O QUE MUDA?", "QUAL É A ESCOLHA?")):
                value["cover"] = {"version": 1, "template_id": template, "title": title}
            with self.subTest(aspect=aspect), Harness(cuts, mode="simple", key="", extra=("--burn-captions", "true")) as h:
                self.assertEqual(batch.main(), 0)
                renderer = h.cinematic if aspect == "16:9" else h.tracking
                renderer.assert_called_once()
                self.assertEqual(batch.render_cover.call_count, 2)
                self.assertEqual([call.kwargs["cover"] for call in batch.render_cover.call_args_list], [value["cover"] for value in cuts])
                cached = list((h.cache / "simple-video").glob("*.mp4"))
                self.assertEqual(len(cached), 1)
                self.assertEqual(cached[0].read_bytes(), b"media")
                self.assertTrue(cached[0].with_suffix(".json").is_file())
                results = h.completed.call_args.args[1]["cuts"]
                self.assertEqual(len(results), 2)
                self.assertTrue(all("capa" in row["files"] for row in results))
                if aspect == "9:16":
                    self.assertEqual(batch.criar_legendas_corte.call_count, 2, "cada capa ainda entra no próprio flash")
                self.assertFalse(h.work.exists())

                # A later invocation can reuse the artifact even after temporary work/output cleanup.
                self.assertEqual(batch.main(), 0)
                renderer.assert_called_once()
                self.assertEqual(batch.render_cover.call_count, 4)

    def test_simple_mode_burns_captions_by_default_and_supports_clean_video_option(self):
        # Por padrão, queima legendas no corte vertical
        cuts = [cut(aspect="9:16", editorial=False)]
        with Harness(cuts, mode="simple", key="") as h:
            self.assertEqual(batch.main(), 0)
            h.tracking.assert_called_once()
            batch.criar_legendas_corte.assert_called_once()
            batch.criar_srt_limpo.assert_not_called()

        # Com --burn-captions false, gera o vídeo limpo sem queimar legendas
        with Harness(cuts, mode="simple", key="", extra=("--burn-captions", "false")) as h:
            self.assertEqual(batch.main(), 0)
            h.tracking.assert_called_once()
            batch.criar_legendas_corte.assert_not_called()
            batch.criar_srt_limpo.assert_called_once()
            results = h.completed.call_args.args[1]["cuts"]
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["files"]["video"], results[0]["files"]["videoLegenda"])

    def test_simple_video_cache_invalidates_for_source_span_treatment_fade_and_corruption(self):
        with Harness([], mode="simple", key="") as h:
            source = h.touch(h.root / "source.mp4", b"source A")
            common = {"aspect": "16:9", "work_dir": h.root / "render-work", "cache_dir": h.cache / "simple-video",
                      "lower_third": LowerThird(), "fade_out_visual": False}
            output = h.out / "copy.mp4"
            first = batch._render_simple_video(source, 10, 20, output, **common)
            second = batch._render_simple_video(source, 10, 20, output, **common)
            self.assertFalse(first["cache_hit"])
            self.assertTrue(second["cache_hit"])
            h.cinematic.assert_called_once()
            self.assertEqual(first["sha256"], second["sha256"])
            (common["cache_dir"] / f"{first['key']}.mp4").write_bytes(b"corrupt cache")
            self.assertFalse(batch._render_simple_video(source, 10, 20, output, **common)["cache_hit"])
            self.assertEqual(h.cinematic.call_count, 2)
            for overrides, start, end in (({}, 11, 20), ({"lower_third": LowerThird("crop", .3)}, 10, 20),
                                           ({"fade_out_visual": True}, 10, 20)):
                self.assertFalse(batch._render_simple_video(source, start, end, output, **{**common, **overrides})["cache_hit"])
            source.write_bytes(b"source B")
            self.assertFalse(batch._render_simple_video(source, 10, 20, output, **common)["cache_hit"])
            self.assertEqual(h.cinematic.call_count, 6)

    def test_cover_failure_skips_only_that_simple_cut_before_tracking(self):
        with Harness([cut(editorial=False), cut(editorial=False)], mode="simple", key="") as h:
            renderer = batch.render_cover.side_effect
            attempts = []
            def cover(*args, **kwargs):
                attempts.append(1)
                if len(attempts) == 1:
                    raise batch.CoverError("Título de capa não cabe no mínimo permitido")
                return renderer(*args, **kwargs)
            batch.render_cover.side_effect = cover
            self.assertEqual(batch.main(), 0)
            h.tracking.assert_called_once()
            result = h.completed.call_args.args[1]
            self.assertEqual([row["index"] for row in result["cuts"]], [2])
            self.assertIn("capa", result["cuts"][0]["files"])
            self.assertEqual(result["errors"][0]["index"], 1)
            self.assertEqual(result["cuts"][0]["render"]["first_original_clip_seconds"], 0)

    def test_editorial_cover_upload_failure_never_emits_ready_cut(self):
        with Harness([cut()], mode="editorial") as h:
            upload = h.uploader.upload
            def fail_cover(path, **kwargs):
                if str(path).endswith("_capa.jpg"):
                    raise RuntimeError("capa upload failed")
                return upload(path, **kwargs)
            h.uploader.upload = fail_cover
            self.assertEqual(batch.main(), 1)
            self.assertFalse(any("ready_cut" in call.kwargs for call in h.emit.call_args_list))

    def test_editorial_routes_formats_and_exact_plan_without_silent_span_adjustment(self):
        cuts = [cut(), cut(aspect="16:9")]
        expected = batch.normalizar_cortes(json.dumps(cuts))
        with Harness(cuts, mode="editorial", extra=("--lower-third-mode", "crop", "--lower-third-height", ".30")) as h:
            with patch.object(batch, "ajustar_inicio_sem_silencio", side_effect=AssertionError("must not trim")):
                self.assertEqual(batch.main(), 0)
            self.assertEqual(h.renderer.call_count, 2)
            h.tracking.assert_not_called()
            h.cinematic.assert_not_called()
            for index, call in enumerate(h.renderer.call_args_list):
                self.assertEqual(call.args[2], expected[index]["editorial"])
                self.assertEqual(call.kwargs["aspect"], cuts[index]["formato"])
                self.assertEqual(call.kwargs["lower_third"], LowerThird("crop", .30))
                self.assertEqual(call.kwargs["font_dir"], h.root/"fonts")
                self.assertEqual(call.kwargs["voice_dir"], h.cache/editorial_fingerprint(expected[index]["editorial"])/"voice")
            self.assertFalse(h.work.exists())
            self.assertTrue(list(h.cache.rglob("accepted.wav")))

    def test_editorial_files_and_post_metadata_remain_publisher_compatible(self):
        with Harness([cut(), cut(aspect="16:9")], mode="editorial") as h:
            self.assertEqual(batch.main(), 0)
            names = [item["name"] for item in h.uploader.uploads]
            self.assertTrue(any(name.endswith("_legenda.mp4") for name in names))
            self.assertTrue(any(name.endswith("_16x9.mp4") for name in names))
            self.assertEqual(sum(name.endswith("_post.txt") for name in names), 2)
            self.assertEqual(sum(name.endswith(".srt") for name in names), 2)
            self.assertFalse(any("report" in name or "cache" in name or name.endswith(".wav") for name in names))
            result = h.completed.call_args.args[1]
            self.assertEqual(result["completedCount"], 2)
            self.assertEqual(result["errors"], [])
            for row in result["cuts"]:
                self.assertEqual(row["files"]["videoLegenda"], row["files"]["video"])

    def test_original_duration_routes_render_posts_uploads_and_ready_results_together(self):
        cuts = []
        for index, duration in enumerate((179.9, 180, 180.1), 1):
            value = cut()
            value.update(titulo=f"História completa {index}", inicio=0, fim=900,
                         destino="reels_tiktok", legenda_post=f"Legenda vertical {index}.",
                         descricao=f"Descrição YouTube {index}.", tags=[f"palavra {index}"])
            value["editorial"]["scenes"][0].update(
                text="Uma contribuição própria completa que acompanha o contexto da fala. " * 18,
                background={"start": 800, "end": 900}, evidence=[{"start": 800, "end": 900}],
            )
            value["editorial"]["scenes"][1].update(start=10, end=10 + duration)
            cuts.append(value)

        with Harness(cuts, mode="editorial") as h:
            self.assertEqual(batch.main(), 0)
            self.assertEqual(h.renderer.call_count, 3)
            h.tracking.assert_not_called()
            h.cinematic.assert_not_called()
            result = h.completed.call_args.args[1]
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["completedCount"], 3)
            expected_aspects = ("9:16", "9:16", "16:9")
            for index, (call, row, aspect) in enumerate(zip(h.renderer.call_args_list, result["cuts"], expected_aspects), 1):
                self.assertEqual(call.kwargs["aspect"], aspect)
                self.assertEqual(row["formato"], aspect)
                self.assertEqual(row["destino"], "youtube" if aspect == "16:9" else "reels_tiktok")
                self.assertEqual(row["files"]["videoLegenda"], row["files"]["video"])

                def uploaded_file(kind):
                    upload_index = int(row["files"][kind]["id"].removeprefix("file-")) - 1
                    return h.uploader.uploads[upload_index]

                video = uploaded_file("video")
                self.assertEqual(video["name"], Path(call.args[3]).name)
                self.assertTrue(video["name"].endswith("_16x9.mp4" if aspect == "16:9" else "_legenda.mp4"))
                self.assertEqual(video["folder"], "folder")
                post = uploaded_file("post")
                self.assertTrue(post["name"].endswith("_16x9_post.txt" if aspect == "16:9" else "_post.txt"))
                post_text = post["data"].decode("utf-8")
                self.assertIn(cuts[index - 1]["titulo"], post_text)
                self.assertIn(f"Descrição YouTube {index}." if aspect == "16:9" else f"Legenda vertical {index}.", post_text)
                if aspect == "16:9":
                    self.assertIn(f"Tags / Palavras-chave: palavra {index}", post_text)
                    self.assertNotIn(f"Legenda vertical {index}.", post_text)

            ready_rows = [call.kwargs["ready_cut"] for call in h.emit.call_args_list if "ready_cut" in call.kwargs]
            self.assertEqual(ready_rows, result["cuts"])
            persisted = json.loads((h.out/"render-batch-result.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["cuts"], result["cuts"])

    def test_one_editorial_failure_preserves_accepted_voice_and_continues_batch(self):
        with Harness([cut(label="Falha"), cut(label="Aceita")], mode="editorial") as h:
            self.assertEqual(batch.main(), 0)
            self.assertEqual(h.renderer.call_count, 2)
            detail, result = h.completed.call_args.args
            self.assertIn("1/2", detail)
            self.assertNotIn("2 cortes concluídos", detail)
            self.assertEqual([error["index"] for error in result["errors"]], [1])
            self.assertEqual([row["index"] for row in result["cuts"]], [2])
            self.assertEqual(len(list(h.cache.rglob("accepted.wav"))), 2)
            self.assertFalse(h.work.exists())
            self.assertEqual(json.loads((h.out/"render-batch-result.json").read_text(encoding="utf-8"))["errors"], result["errors"])

    def test_all_editorial_failures_report_errors_and_return_failure(self):
        with Harness([cut(label="Falha")], mode="editorial") as h:
            self.assertEqual(batch.main(), 1)
            h.completed.assert_not_called()
            terminal = h.emit.call_args.kwargs
            self.assertEqual(terminal["status"], "error")
            self.assertEqual(terminal["result"]["completedCount"], 0)
            self.assertEqual(len(terminal["result"]["errors"]), 1)
            self.assertTrue((h.out/"render-batch-result.json").exists())

    def test_editorial_upload_failure_is_reported_without_stopping_the_next_cut(self):
        with Harness([cut(), cut()], mode="editorial") as h:
            original_upload = h.uploader.upload
            def upload(path, **kwargs):
                if Path(path).name.startswith("corte_01_"):
                    raise RuntimeError("Falha controlada no upload")
                return original_upload(path, **kwargs)
            h.uploader.upload = upload
            self.assertEqual(batch.main(), 0)
            result = h.completed.call_args.args[1]
            self.assertEqual([row["index"] for row in result["cuts"]], [2])
            self.assertEqual([error["index"] for error in result["errors"]], [1])
            self.assertIn("upload", result["errors"][0]["error"])

    def test_workflow_never_caches_voice_on_public_repositories(self):
        workflow = (Path(__file__).parents[1]/".github/workflows/renderizar.yml").read_text(encoding="utf-8")
        for action in ("actions/cache/restore@v4", "actions/cache/save@v4"):
            prefix = workflow[:workflow.index(action)].split("      - name:")[-1]
            self.assertIn("github.event.repository.private == true", prefix)
            self.assertIn("inputs.cut_mode == 'editorial'", prefix)
        save = workflow[:workflow.index("actions/cache/save@v4")].split("      - name:")[-1]
        self.assertIn("always()", save)
        self.assertIn("${{ inputs.video_file_id }}-${{ github.run_id }}-${{ github.run_attempt }}", workflow)
        self.assertNotIn("actions/upload-artifact", workflow)


if __name__ == "__main__":
    unittest.main()
